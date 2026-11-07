import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import worker from "../src/worker.mjs";
import { configurationStatus } from "../src/status.mjs";

const target = (id = "private-id", overrides = {}) => ({ id,
    repository: "private-owner/private-repo", workflow: "Checkin.yml", ref: "main",
    token_secret: "PRIVATE_TOKEN", enabled: false, ...overrides });
const access = "dummy_access_" + "x".repeat(40);
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a,b) => timingSafeEqual(Buffer.from(a),Buffer.from(b));
const configured = (targets = [target()]) => ({
    DEBUG_ACCESS_TOKEN: access,
    TRIGGER_CONFIG: JSON.stringify({ version: 1, targets }),
    PRIVATE_TOKEN: "github_pat_private_marker_value", SCHEDULES: {},
});

function denyEffects(t) {
    return t.mock.method(globalThis, "fetch", () => assert.fail("Status must never call external services"));
}

test("missing configuration gives a usable read-only page and never initializes schedules", async (t) => {
    const http = denyEffects(t);
    const env = { SCHEDULES: { idFromName() { assert.fail("Status must not access objects"); } } };
    const response = await worker.fetch(new Request("https://status.test/"), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /text\/plain/);
    assert.equal(await response.text(), "hello world");
    assert.equal(http.mock.callCount(), 0);
});

test("health reports local configuration without identities, raw JSON, or secret values", async (t) => {
    const http = denyEffects(t);
    const env = configured();
    const response = await worker.fetch(new Request("https://status.test/health?token=query-private-marker", {headers:{Authorization:`Bearer ${access}`}}), env);
    const raw = await response.text();
    const status = JSON.parse(raw);
    assert.equal(status.mode, "read_only");
    assert.equal(status.config.state, "valid");
    assert.equal(status.targets.total, 1);
    assert.equal(status.github_tokens.configured, 1);
    assert.equal(status.github_tokens.verified, false);
    assert.equal(status.schedule.state, "disabled");
    for (const privateValue of ["private-owner", "private-repo", "private-id", "PRIVATE_TOKEN",
            env.PRIVATE_TOKEN, "query-private-marker", env.TRIGGER_CONFIG]) assert.ok(!raw.includes(privateValue));
    assert.equal(http.mock.callCount(), 0);
});

test("invalid JSON and object bindings report safe actionable diagnostics", async (t) => {
    denyEffects(t);
    for (const [raw, code] of [["{\"private-marker\":", "JSON_SYNTAX"], [{ private: "marker" }, "JSON_TYPE"]]) {
        const env = { TRIGGER_CONFIG: raw };
        const status = configurationStatus(env);
        assert.equal(status.config.state, "invalid");
        assert.equal(status.config.error.code, code);
        const html = await (await worker.fetch(new Request("https://status.test/"), env)).text();
        assert.ok(!html.includes("private-marker"));
        assert.equal(html, "hello world");
    }
});

test("known invalid fields and duplicates are identified without echoing supplied values", () => {
    const scenarios = [
        [{ version: 2, targets: [] }, "version"],
        [{ version: 1, targets: [target("private-id", { ref: "secret..marker" })] }, "targets[0].ref"],
        [{ version: 1, targets: [target(), target()] }, "targets[1].id"],
        [{ version: 1, targets: [target("a"), target("b")] }, "targets[1].repository"],
        [{ version: 1, targets: [target("a", { secret_marker: "private-value" })] }, "targets[0]"],
    ];
    for (const [raw, field] of scenarios) {
        const result = configurationStatus({ TRIGGER_CONFIG: JSON.stringify(raw) });
        assert.equal(result.config.state, "invalid");
        assert.equal(result.config.error.field, field);
        assert.ok(!JSON.stringify(result).includes("secret_marker"));
        assert.ok(!JSON.stringify(result).includes("private-value"));
    }
});

test("missing and malformed tokens are distinct from configured-but-unverified tokens", () => {
    const env = configured([target("a", { enabled: true }), target("b", {
        repository: "other/repo", token_secret: "OTHER_TOKEN", enabled: true })]);
    const status = configurationStatus(env);
    assert.equal(status.github_tokens.configured, 1);
    assert.equal(status.github_tokens.missing, 1);
    assert.equal(status.schedule.state, "needs_tokens");
    env.OTHER_TOKEN = "Bearer private-token";
    assert.equal(configurationStatus(env).github_tokens.invalid, 1);
    env.OTHER_TOKEN = "github_pat_other_dummy_value";
    assert.equal(configurationStatus(env).schedule.state, "enabled_unverified");
});

test("a disabled target's missing token does not block a ready enabled target", () => {
    const env = configured([target("a", { enabled: true }), target("b", {
        repository: "other/repo", token_secret: "OTHER_TOKEN" })]);
    assert.equal(configurationStatus(env).schedule.state, "enabled_unverified");
    delete env.SCHEDULES;
    assert.equal(configurationStatus(env).schedule.state, "needs_binding");
});

test("WeCom configuration appears without exposing webhook or claiming verified delivery", () => {
    const env = configured();
    env.WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-webhook-key";
    const status = configurationStatus(env);
    assert.equal(status.wecom.state, "configured");
    assert.equal(status.wecom.verified, false);
    assert.ok(!JSON.stringify(status).includes("private-webhook-key"));
    env.WECOM_WEBHOOK_URL = "https://evil.test/private";
    assert.equal(configurationStatus(env).wecom.state, "invalid");
});

test("public status has no forms, scripts, sensitive values or caching", async (t) => {
    denyEffects(t);
    const env = configured();
    const response = await worker.fetch(new Request("https://status.test/"), env);
    const html = await response.text();
    assert.match(response.headers.get("Cache-Control"), /no-store/);
    assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.ok(!/<script|<form|<input/i.test(html));
    assert.equal(html, "hello world");
    for (const value of ["private-owner", "private-repo", "PRIVATE_TOKEN", env.PRIVATE_TOKEN]) assert.ok(!html.includes(value));
});

test("POST cannot trigger anything and HEAD is bodyless", async (t) => {
    const http = denyEffects(t);
    for (const path of ["/", "/health"]) {
        const response = await worker.fetch(new Request(`https://status.test${path}`, { method: "POST", headers:{Authorization:`Bearer ${access}`} }), configured());
        assert.equal(response.status, 405);
        assert.match(response.headers.get("Allow"), /GET/);
        const head = await worker.fetch(new Request(`https://status.test${path}`, { method: "HEAD", headers:{Authorization:`Bearer ${access}`} }), configured());
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
    }
    assert.equal((await worker.fetch(new Request("https://status.test/trigger"), configured())).status, 404);
    assert.equal(http.mock.callCount(), 0);
});

test("configured admin adds only a private-data-free same-origin bootstrap", async (t) => {
    denyEffects(t);
    const env = { ...configured(), DEBUG_ACCESS_TOKEN: "private_access_marker_" + "x".repeat(32),
        SCHEDULES: { idFromName() { assert.fail("Public page must not read persisted state"); } } };
    const response = await worker.fetch(new Request("https://status.test/token#token=never-echo-this"), env);
    const html = await response.text();
    assert.match(html, /src="\/admin\/client\.js"/);
    assert.match(html, /data-admin-panel[^>]*hidden/);
    assert.match(html, /data-access-input/);
    assert.match(response.headers.get("Content-Security-Policy"), /script-src 'self'/);
    assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'self'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(response.headers.get("Content-Security-Policy")));
    for (const value of ["private-owner", "private-id", "PRIVATE_TOKEN", env.PRIVATE_TOKEN,
        env.DEBUG_ACCESS_TOKEN, env.TRIGGER_CONFIG, "never-echo-this"]) assert.ok(!html.includes(value));
    const health = await worker.fetch(new Request("https://status.test/health"), env);
    assert.ok(!health.headers.get("Content-Security-Policy").includes("script-src 'self'"));
    assert.ok(!(await health.text()).includes("private_access_marker"));
});

test("missing or invalid access secret keeps public HTML completely script-free", async (t) => {
    denyEffects(t);
    for (const token of [undefined, "", "short", "x".repeat(129), "x".repeat(32) + "\n"]) {
        const response = await worker.fetch(new Request("https://status.test/"), { ...configured(), DEBUG_ACCESS_TOKEN: token });
        assert.ok(!/<script|data-admin-panel/.test(await response.text()));
    }
});
