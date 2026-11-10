import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import worker, { TriggerSchedule } from "../src/worker.mjs";

crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const origin = "https://unit.test";
const credentials = "Basic " + Buffer.from("admin:dummy-long-secret-for-tests").toString("base64");
const uuid = "00000000-0000-4000-8000-000000000001";

function fixture(t) {
    t.mock.method(Date, "now", () => Date.parse("2026-11-08T00:05:00+08:00"));
    t.mock.method(console, "log", () => {});
    const http = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    const env = { DEBUG_ACCESS_TOKEN: "dummy_access_" + "x".repeat(40), ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "dummy-long-secret-for-tests", GITHUB_TOKEN_A: "github_pat_dummy_tests",
        TRIGGER_CONFIG: JSON.stringify({ version: 1, targets: [{ id: "a", repository: "owner/repo",
            workflow: "Checkin.yml", ref: "main", token_secret: "GITHUB_TOKEN_A", enabled: true,
            schedule: { mode: "fixed", times: ["09:00", "12:00"] } }] }) };
    const objects = new Map(), stores = new Map(), internal = [];
    env.SCHEDULES = { idFromName: name => name, get(name) {
        if (!objects.has(name)) {
            const values = new Map();
            let alarm = null, queue = Promise.resolve();
            const storage = { async get(k) { return structuredClone(values.get(k)); },
                async put(k, v) {
                    const batch = structuredClone(typeof k === "string" ? { [k]: v } : k);
                    for (const [name, saved] of Object.entries(batch)) values.set(name, saved);
                }, async getAlarm() { return alarm; },
                async setAlarm(v) { alarm = v; }, async deleteAlarm() { alarm = null; } };
            const ctx = { storage, blockConcurrencyWhile(fn) { const p = queue.then(fn); queue = p.catch(() => {}); return p; } };
            objects.set(name, new TriggerSchedule(ctx, env));
            stores.set(name, { values, storage });
        }
        return { fetch(request) { internal.push({ name, url: request.url, headers: request.headers });
            return objects.get(name).fetch(request); } };
    } };
    const call = (path, body, headers = {}) => worker.fetch(new Request(origin + path, {
        method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : {
            Origin: origin, "Content-Type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    const login = async () => {
        const response = await call("/api/admin/session/login", {}, { Authorization: credentials });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, "AUTHENTICATED");
        return { Cookie: response.headers.get("Set-Cookie").split(";", 1)[0], "X-CSRF-Token": body.csrf_token };
    };
    return { env, call, login, http, internal, stores, objects };
}

test("cookie login survives reload and reaches health and separately named target object", async t => {
    const f = fixture(t), headers = await f.login();
    assert.equal((await f.call("/api/admin/session", undefined, headers)).status, 200);
    assert.equal((await f.call("/health", undefined, headers)).status, 200);
    const listing = await f.call("/api/admin/targets", undefined, headers);
    assert.equal(listing.status, 200);
    const target = (await listing.json()).targets[0];
    assert.equal(target.id, "a");
    assert.equal(target.slots.length, 2);
    assert.equal(target.next_run, "2026-11-08T01:00:00.000Z");
    assert.ok(f.stores.has("auth:v1") && f.stores.has("v1:a"));
    const forwarded = f.internal.find(r => r.url.includes("/admin/state"));
    assert.equal(new URL(forwarded.url).origin, origin);
    assert.equal(forwarded.headers.get("Authorization"), null);
    assert.equal(forwarded.headers.get("Cookie"), headers.Cookie);
    assert.equal(f.http.mock.callCount(), 0);
});

test("cookie mutations enforce Origin and CSRF before effects and revoke copied cookies", async t => {
    const f = fixture(t), headers = await f.login();
    for (const [bad, status] of [[{ Cookie: headers.Cookie }, 403], [{ ...headers, "X-CSRF-Token": "x".repeat(43) }, 403],
        [{ ...headers, Origin: "https://evil.test" }, 403]]) {
        assert.equal((await f.call("/api/admin/targets/a/run", { request_id: uuid }, bad)).status, status);
        assert.equal((await f.call("/api/admin/session", undefined, headers)).status, 200);
    }
    assert.equal(f.http.mock.callCount(), 0);
    assert.equal((await f.call("/api/admin/targets/a/enabled", { enabled: false }, headers)).status, 200);
    assert.equal((await f.call("/api/admin/targets/a/run", { request_id: uuid }, headers)).status, 409);
    assert.equal((await f.call("/api/admin/targets/a/enabled", { enabled: true }, headers)).status, 200);
    assert.equal((await f.call("/api/admin/targets/a/run", { request_id: uuid }, headers)).status, 200);
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal((await f.call("/api/admin/targets/a/logs/clear", {}, headers)).status, 200);
    assert.equal((await f.call("/api/admin/targets/a/run", { request_id: uuid }, headers)).status, 200);
    assert.equal(f.http.mock.callCount(), 1);
    const logout = await f.call("/api/admin/session/logout", {}, headers);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("Set-Cookie"), /Max-Age=0/);
    assert.equal((await f.call("/api/admin/targets", undefined, headers)).status, 401);
});

test("session storage errors are safe503 and Basic compatibility does not depend on auth storage", async t => {
    const f = fixture(t), headers = await f.login();
    f.stores.get("auth:v1").storage.get = async () => { throw new Error("private_storage_marker"); };
    for (const path of ["/health", "/api/admin/targets", "/api/admin/session"]) {
        const response = await f.call(path, undefined, headers);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: "STORAGE_UNAVAILABLE" });
    }
    assert.equal((await f.call("/api/admin/targets", undefined, { Authorization: credentials })).status, 200);
    assert.equal((await f.call("/api/admin/targets/a/enabled", { enabled: false }, { Authorization: credentials })).status, 200);
    f.env.DEBUG_ACCESS_TOKEN = "";
    assert.equal((await f.call("/api/admin/session", undefined, headers)).status, 404);
    assert.equal(f.http.mock.callCount(), 0);
});

test("cookie schedule save and reset forward Origin/CSRF and reject stale revisions without dispatch", async t => {
    const f = fixture(t), headers = await f.login();
    const state = (await (await f.call("/api/admin/targets", undefined, headers)).json()).targets[0];
    const body = { binding: state.target_binding, revision: 0, schedule: { mode: "fixed", times: ["10:00"] } };
    for (const bad of [{ Cookie: headers.Cookie }, { ...headers, "X-CSRF-Token": "x".repeat(43) },
        { ...headers, Origin: "https://evil.test" }]) {
        assert.equal((await f.call("/api/admin/targets/a/schedule", body, bad)).status, 403);
        assert.equal(f.stores.get("v1:a").values.has("schedule_settings"), false);
    }
    const saved = await f.call("/api/admin/targets/a/schedule", body, headers);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).target.schedule_revision, 1);
    const forwarded = f.internal.find(r => r.url.includes("/admin/schedule?"));
    assert.equal(forwarded.headers.get("X-CSRF-Token"), headers["X-CSRF-Token"]);
    assert.equal(forwarded.headers.get("Origin"), origin);
    assert.equal((await f.call("/api/admin/targets/a/schedule", body, headers)).status, 409);
    const restored = await f.call("/api/admin/targets/a/schedule/reset", { binding: body.binding, revision: 1 }, headers);
    assert.equal(restored.status, 200);
    const actual = (await restored.json()).target;
    assert.equal(actual.schedule_source, "variable");
    assert.equal(actual.schedule_revision, 2);
    assert.deepEqual(actual.schedule, { mode: "fixed", times: ["09:00", "12:00"] });
    assert.equal(f.http.mock.callCount(), 0);
});
