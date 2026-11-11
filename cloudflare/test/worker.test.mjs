import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { parseConfig, randomMinute, TriggerSchedule } from "../src/worker.mjs";

const target = (id = "github_a", overrides = {}) => ({
    id, repository: "owner/AgentRouter-Check-in", workflow: "Checkin.yml", ref: "dev-plus",
    token_secret: "GITHUB_TOKEN_A", enabled: true, ...overrides,
});
const rawConfig = (targets) => JSON.stringify({ version: 1, targets });
const request = (id = "github_a") => new Request(`https://scheduler.internal/init?id=${id}`, { method: "POST" });

function fixture(t, options = {}) {
    let now = Date.parse(options.now ?? "2026-11-07T00:05:00+08:00");
    const samples = [...(options.samples ?? [60, 120, 180])];
    const values = new Map();
    let alarm = null;
    const storage = {
        async get(key) { return structuredClone(values.get(key)); },
        async put(key, value) {
            const batch = structuredClone(typeof key === "string" ? { [key]: value } : key);
            for (const [name, saved] of Object.entries(batch)) values.set(name, saved);
        },
        async getAlarm() { return alarm; },
        async setAlarm(value) { alarm = value; },
        async deleteAlarm() { alarm = null; },
    };
    let queue = Promise.resolve();
    const ctx = { storage, blockConcurrencyWhile(fn) {
        const pending = queue.then(fn);
        queue = pending.catch(() => {});
        return pending;
    } };
    const env = { TRIGGER_CONFIG: rawConfig(options.targets ?? [target()]),
        GITHUB_TOKEN_A: "github_pat_dummy_for_unit_tests" };
    t.mock.method(Date, "now", () => now);
    const random = t.mock.method(crypto, "getRandomValues", (array) => {
        array[0] = samples.shift() ?? 0;
        return array;
    });
    const logs = [];
    t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
    const http = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    return { values, storage, env, ctx, object: new TriggerSchedule(ctx, env), http, random, logs,
        setNow(value) { now = Date.parse(value); },
        alarm() { return alarm; }, plan() { return values.get("plan"); } };
}

test("configuration defaults empty and enables new targets unless explicitly disabled", () => {
    assert.deepEqual(parseConfig(undefined), []);
    assert.deepEqual(parseConfig(rawConfig([target("github_a", { enabled: false })]))[0].enabled, false);
    const missing = target();
    delete missing.enabled;
    assert.equal(parseConfig(rawConfig([missing]))[0].enabled, true);
});

test("configuration rejects duplicate IDs, case-insensitive repositories and invalid trust boundaries", () => {
    const invalid = ["secret", "{}", '{"version":2,"targets":[]}',
        rawConfig([target(), target("github_a", { repository: "owner/other" })]),
        rawConfig([target(), target("github_b", { repository: "OWNER/agentrouter-check-IN" })]),
        rawConfig([target("github_a", { repository: "https://evil.test/repo" })]),
        rawConfig([target("github_a", { workflow: "../Checkin.yml" })]),
        rawConfig([target("github_a", { ref: "dev..plus" })]),
        rawConfig([target("github_a", { ref: "refs/heads/.hidden" })]),
        rawConfig([target("github_a", { ref: "foo.lock" })]),
        rawConfig([target("github_a", { token_secret: "token\nprivate" })]),
        rawConfig([target("github_a", { enabled: "true" })]),
        rawConfig([target("github_a", { private_field: "private" })])];
    for (const raw of invalid) assert.throws(() => parseConfig(raw), /^Error: CONFIG_INVALID$/);
    assert.equal(parseConfig(rawConfig([target("github_a", { ref: "feature/check-in" })]))[0].ref, "feature/check-in");
});

test("random minute includes both endpoints and rejects biased tail", (t) => {
    const samples = [0, 1320, 0xffffffff, 757];
    t.mock.method(crypto, "getRandomValues", (array) => { array[0] = samples.shift(); return array; });
    assert.equal(randomMinute(), 0);
    assert.equal(randomMinute(), 1320);
    assert.equal(randomMinute(), 757);
    assert.equal(samples.length, 0);
});

test("first initialization before window stores Shanghai date and correct UTC alarm", async (t) => {
    const f = fixture(t, { samples: [0] });
    assert.equal((await f.object.fetch(request())).status, 200);
    assert.equal(f.plan().date, "2026-11-07");
    assert.equal(f.plan().slots[0].at, Date.parse("2026-11-07T01:00:00+08:00"));
    assert.equal(f.alarm(), f.plan().slots[0].at);
    assert.equal(f.http.mock.callCount(), 0);
});

test("first initialization inside window schedules tomorrow including year rollover", async (t) => {
    const f = fixture(t, { now: "2026-12-31T01:00:00+08:00", samples: [1320] });
    await f.object.fetch(request());
    assert.equal(f.plan().date, "2027-01-01");
    assert.equal(f.plan().slots[0].at, Date.parse("2027-01-01T23:00:00+08:00"));
});

test("restart and repeated Cron preserve target and repair lost alarm without redraw", async (t) => {
    const f = fixture(t);
    await f.object.fetch(request());
    const original = structuredClone(f.plan());
    await f.storage.deleteAlarm();
    const restarted = new TriggerSchedule(f.ctx, f.env);
    await restarted.fetch(request());
    assert.deepEqual(f.plan(), original);
    assert.equal(f.alarm(), original.slots[0].at);
    assert.equal(f.random.mock.callCount(), 1);
});

test("repair after today's target preserves delayed same-date delivery", async (t) => {
    const f = fixture(t);
    await f.object.fetch(request());
    const original = structuredClone(f.plan());
    await f.storage.deleteAlarm();
    f.setNow("2026-11-07T02:05:00+08:00");
    await new TriggerSchedule(f.ctx, f.env).fetch(request());
    assert.deepEqual(f.plan(), original);
    assert.ok(f.alarm() >= Date.now());
    assert.equal(f.random.mock.callCount(), 1);
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal(f.plan().last.result, "DISPATCH_ACCEPTED");
});

test("accepted dispatch marks attempt before HTTP and schedules independent next date", async (t) => {
    const f = fixture(t, { now: "2028-02-28T00:05:00+08:00", samples: [60, 60] });
    await f.object.fetch(request());
    f.setNow("2028-02-28T02:00:00+08:00");
    f.http.mock.mockImplementation(async (url, options) => {
        assert.equal(f.plan().slots[0].attempted, true);
        assert.equal(f.plan().slots[0].result, "DISPATCH_UNKNOWN");
        assert.equal(url, "https://api.github.com/repos/owner/AgentRouter-Check-in/actions/workflows/Checkin.yml/dispatches");
        assert.equal(options.method, "POST");
        assert.equal(options.redirect, "manual");
        assert.equal(options.headers.Authorization, "Bearer github_pat_dummy_for_unit_tests");
        assert.deepEqual(JSON.parse(options.body), { ref: "dev-plus" });
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(null, { status: 200 });
    });
    await f.object.alarm();
    assert.equal(f.plan().date, "2028-02-29");
    assert.equal(f.plan().slots[0].at, Date.parse("2028-02-29T02:00:00+08:00"));
    assert.equal(f.plan().last.result, "DISPATCH_ACCEPTED");
    assert.equal(f.random.mock.callCount(), 2);
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 1);
    assert.ok(!JSON.stringify([...f.values]).includes(f.env.GITHUB_TOKEN_A));
});

for (const status of [204, 302, 401, 403, 404, 422, 429, 500]) {
    test(`HTTP ${status} is recorded safely without retry or response body access`, async (t) => {
        const f = fixture(t);
        await f.object.fetch(request());
        f.setNow("2026-11-07T02:00:00+08:00");
        f.http.mock.mockImplementation(async () => ({ status,
            get body() { throw new Error("response-body-secret"); } }));
        await f.object.alarm();
        await f.object.alarm();
        assert.equal(f.http.mock.callCount(), 1);
        assert.equal(f.plan().last.result, status === 204 ? "DISPATCH_ACCEPTED" : `DISPATCH_HTTP_${status}`);
        assert.ok(!f.logs.join().includes("response-body-secret"));
    });
}

test("ambiguous exception is unknown, never leaked or retried", async (t) => {
    const f = fixture(t);
    await f.object.fetch(request());
    f.setNow("2026-11-07T02:00:00+08:00");
    f.http.mock.mockImplementation(async () => { throw new Error("private-token-marker"); });
    await f.object.alarm();
    await f.object.alarm();
    assert.equal(f.plan().last.result, "DISPATCH_UNKNOWN");
    assert.equal(f.http.mock.callCount(), 1);
    assert.ok(!f.logs.join().includes("private-token-marker"));
});

test("concurrent callbacks serialize and cannot double-dispatch", async (t) => {
    const f = fixture(t);
    await Promise.all([f.object.fetch(request()), f.object.fetch(request())]);
    assert.equal(f.random.mock.callCount(), 1);
    f.setNow("2026-11-07T02:00:00+08:00");
    await Promise.all([f.object.alarm(), f.object.alarm(), f.object.fetch(request())]);
    assert.equal(f.http.mock.callCount(), 1);
});

for (const reason of ["disabled", "removed", "missing-token", "invalid-token", "invalid-config"]) {
    test(`${reason} suppresses pending alarm and all outbound requests`, async (t) => {
        const f = fixture(t);
        await f.object.fetch(request());
        f.setNow("2026-11-07T02:00:00+08:00");
        if (reason === "disabled") f.env.TRIGGER_CONFIG = rawConfig([target("github_a", { enabled: false })]);
        if (reason === "removed") f.env.TRIGGER_CONFIG = rawConfig([]);
        if (reason === "missing-token") delete f.env.GITHUB_TOKEN_A;
        if (reason === "invalid-token") f.env.GITHUB_TOKEN_A = "secret\nmarker";
        if (reason === "invalid-config") f.env.TRIGGER_CONFIG = "private-marker";
        await f.object.alarm();
        assert.equal(f.http.mock.callCount(), 0);
        assert.equal(f.alarm(), null);
        assert.ok(!f.logs.join().includes("private-marker"));
    });
}

test("disabled initial target needs no random sample or alarm", async (t) => {
    const f = fixture(t, { targets: [target("github_a", { enabled: false })] });
    await f.object.fetch(request());
    assert.equal(f.random.mock.callCount(), 0);
    assert.equal(f.alarm(), null);
});

test("changing target identity cannot reroute existing alarm or redraw same date", async (t) => {
    const f = fixture(t);
    await f.object.fetch(request());
    f.env.TRIGGER_CONFIG = rawConfig([target("github_a", { repository: "owner/other" })]);
    f.setNow("2026-11-07T00:10:00+08:00");
    await f.object.fetch(request());
    assert.equal(f.plan().date, "2026-11-08");
    assert.equal(f.plan().last.result, "TARGET_CHANGED");
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 0);
});

test("early and expired alarms do not send late catch-up requests", async (t) => {
    const f = fixture(t);
    await f.object.fetch(request());
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 0);
    f.setNow("2026-11-08T00:05:00+08:00");
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 0);
    assert.equal(f.plan().date, "2026-11-08");
    assert.equal(f.plan().last.result, "MISSED_DATE");
});

test("failed durable attempt write prevents HTTP request", async (t) => {
    const f = fixture(t);
    await f.object.fetch(request());
    f.setNow("2026-11-07T02:00:00+08:00");
    const put = f.storage.put;
    f.storage.put = async (key, value) => {
        const plan = typeof key === "object" ? key.plan : key === "plan" ? value : null;
        if (plan?.slots[0].attempted) throw new Error("disk-private-marker");
        return put(key, value);
    };
    await assert.rejects(() => f.object.alarm());
    assert.equal(f.http.mock.callCount(), 0);
});

test("crash after attempt persistence does not resend after restart", async (t) => {
    const f = fixture(t);
    await f.object.fetch(request());
    f.setNow("2026-11-07T02:00:00+08:00");
    const put = f.storage.put;
    f.storage.put = async (key, value) => {
        const plan = typeof key === "object" ? key.plan : key === "plan" ? value : null;
        if (plan?.slots[0].result === "DISPATCH_ACCEPTED") throw new Error("disk-error");
        return put(key, value);
    };
    await assert.rejects(() => f.object.alarm());
    assert.equal(f.http.mock.callCount(), 1);
    f.storage.put = put;
    await new TriggerSchedule(f.ctx, f.env).alarm();
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal(f.plan().last.result, "DISPATCH_UNKNOWN");
});

test("dispatch sends one optional WeCom notice after persisted result and never on page visits", async (t) => {
    const f = fixture(t);
    f.env.WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-webhook";
    await f.object.fetch(request());
    f.setNow("2026-11-07T02:00:00+08:00");
    f.http.mock.mockImplementation(async (url) => {
        if (url.startsWith("https://api.github.com/")) return new Response(null, { status: 204 });
        assert.equal(f.plan().slots[0].result, "DISPATCH_ACCEPTED");
        assert.equal(f.plan().slots[0].notification, "NOTIFY_UNKNOWN");
        return Response.json({ errcode: 0 });
    });
    await f.object.alarm();
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 2);
    assert.equal(f.plan().last.result, "DISPATCH_ACCEPTED");
    assert.equal(f.plan().last.notification, "NOTIFY_ACCEPTED");
    await worker.fetch(new Request("https://public.test/"), f.env);
    assert.equal(f.http.mock.callCount(), 2);
});

test("WeCom failure cannot change accepted dispatch or trigger another attempt", async (t) => {
    const f = fixture(t);
    f.env.WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-webhook";
    await f.object.fetch(request());
    f.setNow("2026-11-07T02:00:00+08:00");
    f.http.mock.mockImplementation(async (url) => url.startsWith("https://api.github.com/")
        ? new Response(null, { status: 204 }) : Response.json({ errcode: 93000 }));
    await f.object.alarm();
    await f.object.alarm();
    assert.equal(f.plan().last.result, "DISPATCH_ACCEPTED");
    assert.equal(f.plan().last.notification, "NOTIFY_FAILED");
    assert.equal(f.http.mock.callCount(), 2);
});

test("crash after bot send cannot duplicate dispatch or notification", async (t) => {
    const f = fixture(t);
    f.env.WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-webhook";
    await f.object.fetch(request());
    f.setNow("2026-11-07T02:00:00+08:00");
    f.http.mock.mockImplementation(async (url) => url.startsWith("https://api.github.com/")
        ? new Response(null, { status: 204 }) : Response.json({ errcode: 0 }));
    const put = f.storage.put;
    f.storage.put = async (key, value) => {
        const plan = typeof key === "object" ? key.plan : key === "plan" ? value : null;
        if (plan?.slots[0].notification === "NOTIFY_ACCEPTED") throw new Error("fixture-storage-error");
        return put(key, value);
    };
    await assert.rejects(() => f.object.alarm());
    f.storage.put = put;
    await new TriggerSchedule(f.ctx, f.env).alarm();
    assert.equal(f.http.mock.callCount(), 2);
    assert.equal(f.plan().last.result, "DISPATCH_ACCEPTED");
    assert.equal(f.plan().last.notification, "NOTIFY_UNKNOWN");
});

test("multiple targets have separate state and independent random draws", async (t) => {
    const f = fixture(t, { samples: [60, 120], targets: [target(), target("github_b", { repository: "other/repo" })] });
    const valuesB = new Map();
    const storageB = { ...f.storage,
        async get(key) { return structuredClone(valuesB.get(key)); },
        async put(key, value) {
            const batch = structuredClone(typeof key === "string" ? { [key]: value } : key);
            for (const [name, saved] of Object.entries(batch)) valuesB.set(name, saved);
        } };
    const b = new TriggerSchedule({ ...f.ctx, storage: storageB }, f.env);
    await f.object.fetch(request());
    await b.fetch(request("github_b"));
    assert.notEqual(f.plan().slots[0].at, valuesB.get("plan").slots[0].at);
    assert.equal(f.plan().id, "github_a");
    assert.equal(valuesB.get("plan").id, "github_b");
    assert.equal(f.random.mock.callCount(), 2);
});

test("each target dispatches only its own repository and token", async (t) => {
    const f = fixture(t, { samples: [0, 0, 120, 120], targets: [target(),
        target("github_b", { repository: "other/repo", token_secret: "GITHUB_TOKEN_B" })] });
    f.env.GITHUB_TOKEN_B = "github_pat_other_dummy_for_tests";
    const valuesB = new Map();
    const storageB = { ...f.storage,
        async get(key) { return structuredClone(valuesB.get(key)); },
        async put(key, value) {
            const batch = structuredClone(typeof key === "string" ? { [key]: value } : key);
            for (const [name, saved] of Object.entries(batch)) valuesB.set(name, saved);
        } };
    const b = new TriggerSchedule({ ...f.ctx, storage: storageB }, f.env);
    await f.object.fetch(request());
    await b.fetch(request("github_b"));
    f.setNow("2026-11-07T01:00:00+08:00");
    await f.object.alarm();
    await b.alarm();
    const calls = f.http.mock.calls;
    assert.equal(calls.length, 2);
    assert.ok(calls[0].arguments[0].includes("/repos/owner/AgentRouter-Check-in/"));
    assert.equal(calls[0].arguments[1].headers.Authorization, `Bearer ${f.env.GITHUB_TOKEN_A}`);
    assert.ok(calls[1].arguments[0].includes("/repos/other/repo/"));
    assert.equal(calls[1].arguments[1].headers.Authorization, `Bearer ${f.env.GITHUB_TOKEN_B}`);
    assert.ok(!JSON.stringify([...valuesB]).includes(f.env.GITHUB_TOKEN_B));
});

test("corrupt persistent state fails closed rather than redrawing or dispatching", async (t) => {
    const f = fixture(t);
    f.values.set("plan", { version: 1, id: "github_a", at: "private-value" });
    await assert.rejects(() => f.object.alarm(), /^Error: STATE_INVALID$/);
    await assert.rejects(() => f.object.fetch(request()), /^Error: STATE_INVALID$/);
    assert.equal(f.random.mock.callCount(), 0);
    assert.equal(f.http.mock.callCount(), 0);
    assert.equal(f.alarm(), null);
});

test("public requests are 404 and daily initialization isolates object failures", async (t) => {
    const f = fixture(t, { targets: [target(), target("github_b", { repository: "other/repo" })] });
    assert.equal((await worker.fetch(new Request("https://public.test/trigger"), f.env)).status, 404);
    const initialized = [];
    f.env.SCHEDULES = {
        idFromName(name) { return name; },
        get(name) { return { async fetch(req) {
            if (name === "catalog:v1") { assert.equal(new URL(req.url).pathname, "/catalog/read"); return Response.json(null); }
            initialized.push(new URL(req.url).searchParams.get("id"));
            if (name.endsWith("github_a")) throw new Error("object-private-marker");
            return new Response(null, { status: 200 });
        } }; },
    };
    await worker.scheduled({}, f.env);
    assert.deepEqual(initialized, ["github_a", "github_b"]);
    assert.ok(!f.logs.join().includes("object-private-marker"));
    assert.equal(f.http.mock.callCount(), 0);
});
