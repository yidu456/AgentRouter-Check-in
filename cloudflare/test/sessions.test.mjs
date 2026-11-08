import assert from "node:assert/strict";
import { test } from "node:test";
import * as sessions from "../src/sessions.mjs";

const origin = "https://sessions.test";
const password = "dummy-session-password-for-tests";
const cookieName = "__Host-ar_session";

function fixture(t) {
    let now = Date.parse("2026-11-08T00:00:00.000Z");
    const values = new Map();
    const names = [];
    const requests = [];
    const writes = [];
    const storage = {
        async get(key) { return structuredClone(values.get(key)); },
        async put(key, value) { writes.push(key); values.set(key, structuredClone(value)); },
        async delete(key) { return values.delete(key); },
    };
    let queue = Promise.resolve();
    const ctx = { storage, blockConcurrencyWhile(callback) {
        const pending = queue.then(callback);
        queue = pending.catch(() => {});
        return pending;
    } };
    const env = { ADMIN_USERNAME: "session-admin", ADMIN_PASSWORD: password,
        DEBUG_ACCESS_TOKEN: "dummy_access_for_session_tests_0123456789" };
    const basicAuthorized = async (request, current) => request.headers.get("Authorization") === "Basic "
        + Buffer.from(`${current.ADMIN_USERNAME}:${current.ADMIN_PASSWORD}`).toString("base64");
    env.SCHEDULES = {
        idFromName(name) { names.push(name); return name; },
        get(name) {
            assert.equal(name, "auth:v1", "session storage must not share a target object");
            return { async fetch(request) {
                requests.push(request);
                return sessions.sessionStorageResponse(request, ctx, env, basicAuthorized);
            } };
        },
    };
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected external request"); });
    const request = (path, options = {}) => new Request(`${options.origin ?? origin}${path}`, {
        method: options.method ?? (path.endsWith("/login") || path.endsWith("/logout") ? "POST" : "GET"),
        headers: options.headers ?? {}, ...(options.body === undefined ? {} : { body: options.body }),
    });
    const call = (path, options) => sessions.sessionApiResponse(request(path, options), env, basicAuthorized);
    const login = (headers = {}, body = "{}", site = origin) => call("/api/admin/session/login", {
        origin: site, body, headers: { Authorization: "Basic " + Buffer.from(`${env.ADMIN_USERNAME}:${env.ADMIN_PASSWORD}`).toString("base64"),
            Origin: site, "Content-Type": "application/json", ...headers },
    });
    const issue = async () => {
        const response = await login();
        assert.equal(response.status, 200);
        return { cookie: response.headers.get("Set-Cookie").split(";", 1)[0], body: await response.json() };
    };
    const check = (cookie, headers = {}) => call("/api/admin/session", { headers: { Cookie: cookie, ...headers } });
    const authorize = (cookie, options = {}) => sessions.sessionAuthorized(request("/api/admin/targets/repo/enabled", {
        ...options, headers: { Cookie: cookie, ...options.headers },
    }), env);
    const logout = (cookie, csrf, headers = {}, body = "{}") => call("/api/admin/session/logout", {
        body, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf, ...headers },
    });
    return { env, values, writes, storage, ctx, names, requests, basicAuthorized, request, call, login, issue, check, authorize, logout,
        advance(milliseconds) { now += milliseconds; } };
}

test("login issues a private host cookie with fixed twelve-hour expiry and safe response headers", async (t) => {
    const f = fixture(t);
    const response = await f.login();
    assert.equal(response.status, 200);
    const cookie = response.headers.get("Set-Cookie");
    assert.match(cookie, /^__Host-ar_session=v1\.[A-Za-z0-9_-]{43}\.\d+\.[A-Za-z0-9_-]{43};/);
    for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=43200"])
        assert.ok(cookie.split("; ").includes(attribute));
    assert.doesNotMatch(cookie, /Domain=/i);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["csrf_token", "expires_at", "status"]);
    assert.equal(body.status, "AUTHENTICATED");
    assert.equal(body.expires_at, "2026-11-08T12:00:00.000Z");
    assert.match(body.csrf_token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.deepEqual(f.names, ["auth:v1"]);
});

test("login rejects missing or incorrect Basic credentials before accessing storage", async (t) => {
    const f = fixture(t);
    for (const Authorization of ["", "Bearer wrong", "Basic " + Buffer.from("session-admin:incorrect").toString("base64")]) {
        const response = await f.login({ Authorization });
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { status: "UNAUTHORIZED" });
    }
    assert.equal(f.values.size, 0);
    assert.equal(f.names.length, 0);
});

test("login requires exact HTTPS Origin and ignores client forwarding headers", async (t) => {
    const f = fixture(t);
    for (const Origin of ["", "null", "https://evil.test", "https://sessions.test/", "https://sessions.test:444"]) {
        const response = await f.login({ Origin, "X-Forwarded-Host": "sessions.test", "X-Forwarded-Proto": "https" });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { status: "ORIGIN_REJECTED" });
    }
    assert.equal((await f.login({}, "{}", "http://sessions.test")).status, 403);
    assert.equal(f.names.length, 0);
});

test("login accepts only bounded empty JSON objects before storage effects", async (t) => {
    const f = fixture(t);
    const cases = [
        ["{}", "text/plain", 415, "JSON_REQUIRED"],
        ["{broken", "application/json", 400, "BODY_INVALID"],
        ["null", "application/json", 400, "BODY_INVALID"],
        ["[]", "application/json", 400, "BODY_INVALID"],
        ['{"extra":"private_marker"}', "application/json", 400, "BODY_INVALID"],
        [" ".repeat(1025), "application/json", 413, "BODY_TOO_LARGE"],
    ];
    for (const [body, type, status, code] of cases) {
        const response = await f.login({ "Content-Type": type }, body);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { status: code });
    }
    assert.equal(f.names.length, 0);
    assert.equal(f.values.size, 0);
    assert.equal((await f.login({ "Content-Type": "application/json; charset=utf-8" }, " { } ")).status, 200);
});

test("refresh and re-created object context recover the same session without extending expiry", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const persisted = structuredClone([...f.values]);
    f.advance(60 * 60 * 1000);
    const response = await f.check(issued.cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), issued.body);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(await f.authorize(issued.cookie), true);
    assert.deepEqual([...f.values], persisted);
    const restarted = { storage: f.storage, blockConcurrencyWhile: (callback) => callback() };
    const direct = await sessions.sessionStorageResponse(f.request("/session/check", { headers: { Cookie: issued.cookie } }),
        restarted, f.env, f.basicAuthorized);
    assert.deepEqual(await direct.json(), issued.body);
});

test("missing duplicate malformed or oversized cookies fail without object access", async (t) => {
    const f = fixture(t);
    const cases = ["", "other=value", `${cookieName}=bad`, `${cookieName}=v1.a.123.b`,
        `${cookieName}=bad; ${cookieName}=bad`, `${cookieName}=${"x".repeat(5000)}`];
    for (const cookie of cases) {
        assert.equal(await f.authorize(cookie), false);
        const response = await f.check(cookie);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { status: "UNAUTHORIZED" });
    }
    assert.equal(await sessions.sessionAuthorized(f.request("/api/admin/targets"), f.env), false);
    assert.equal(f.names.length, 0);
});

test("nonce signature expiry and host tampering cannot authenticate", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const parts = issued.cookie.split("=", 2)[1].split(".");
    for (const index of [1, 2, 3]) {
        const changed = [...parts];
        changed[index] = index === 2 ? String(Number(changed[index]) + 1) : (changed[index][0] === "A" ? "B" : "A") + changed[index].slice(1);
        assert.equal(await f.authorize(`${cookieName}=${changed.join(".")}`), false);
    }
    assert.equal(await f.authorize(issued.cookie, { origin: "https://evil.test",
        headers: { "X-Forwarded-Host": "sessions.test", "X-Forwarded-Proto": "https" } }), false);
    assert.equal(await f.authorize(issued.cookie, { origin: "https://sessions.test:444" }), false);
    assert.equal(await f.authorize(issued.cookie, { origin: "http://sessions.test" }), false);
    f.advance(12 * 60 * 60 * 1000);
    assert.equal(await f.authorize(issued.cookie), false);
    assert.equal((await f.check(issued.cookie)).status, 401);
});

test("password username and hidden-entry rotation each invalidate existing cookies", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    for (const key of ["ADMIN_PASSWORD", "ADMIN_USERNAME", "DEBUG_ACCESS_TOKEN"]) {
        const original = f.env[key];
        f.env[key] += "changed";
        assert.equal(await f.authorize(issued.cookie), false);
        assert.equal((await f.check(issued.cookie)).status, 401);
        f.env[key] = original;
        assert.equal(await f.authorize(issued.cookie), true);
    }
});

test("cookie mutations require exact Origin JSON media type and the session-specific CSRF token", async (t) => {
    const f = fixture(t);
    const first = await f.issue();
    const second = await f.issue();
    const valid = { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": first.body.csrf_token };
    for (const [headers, code] of [[{}, "ORIGIN_REJECTED"], [{ ...valid, Origin: "https://evil.test" }, "ORIGIN_REJECTED"],
        [{ ...valid, Origin: "" }, "ORIGIN_REJECTED"], [{ ...valid, "Content-Type": "text/plain" }, "JSON_REQUIRED"],
        [{ ...valid, "X-CSRF-Token": "wrong" }, "CSRF_REJECTED"],
        [{ ...valid, "X-CSRF-Token": second.body.csrf_token }, "CSRF_REJECTED"]]) {
        await assert.rejects(f.authorize(first.cookie, { method: "POST", headers, body: '{"enabled":false}' }), { message: code });
    }
    assert.equal(await f.authorize(first.cookie, { method: "POST", headers: valid, body: '{"enabled":false}' }), true);
    assert.equal(await f.authorize(first.cookie, { method: "HEAD" }), true);
    assert.notEqual(first.body.csrf_token, second.body.csrf_token);
});

test("logout revokes a copied cookie while leaving other sessions valid", async (t) => {
    const f = fixture(t);
    const first = await f.issue();
    const second = await f.issue();
    const response = await f.logout(first.cookie, first.body.csrf_token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "SIGNED_OUT" });
    assert.match(response.headers.get("Set-Cookie"), /^__Host-ar_session=;.*Max-Age=0/);
    assert.equal(await f.authorize(first.cookie), false);
    assert.equal(await f.authorize(second.cookie), true);
    assert.equal((await f.logout(first.cookie, first.body.csrf_token)).status, 401);
});

test("logout cannot use Basic instead of cookie CSRF and rejects invalid empty-body protocol", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    assert.equal((await f.logout(issued.cookie, "wrong")).status, 403);
    assert.equal((await f.logout(issued.cookie, issued.body.csrf_token, { Origin: "https://evil.test" })).status, 403);
    assert.equal((await f.logout(issued.cookie, issued.body.csrf_token, {}, '{"extra":true}')).status, 400);
    assert.equal((await f.logout("", "", { Authorization: "Basic " + Buffer.from(`session-admin:${password}`).toString("base64") })).status, 401);
    assert.equal(await f.authorize(issued.cookie), true);
});

test("active sessions are capped at 128 and expired records are pruned on new login only", async (t) => {
    const f = fixture(t);
    const issued = [];
    for (let index = 0; index < 128; index++) issued.push(await f.issue());
    const response = await f.login();
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { status: "SESSION_LIMIT" });
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(await f.authorize(issued[0].cookie), true);
    assert.equal(await f.authorize(issued[127].cookie), true);
    const beforeExpiry = structuredClone([...f.values]);
    f.advance(12 * 60 * 60 * 1000);
    assert.equal(await f.authorize(issued[0].cookie), false);
    assert.deepEqual([...f.values], beforeExpiry);
    const fresh = await f.issue();
    assert.equal(await f.authorize(fresh.cookie), true);
    assert.equal(await f.authorize(issued[0].cookie), false);
    const records = [...f.values.values()].find((value) => Array.isArray(value.items));
    assert.equal(records.items.length, 1);
});

test("persistent session state stores hashes not cookie or credential material and key is private", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const state = JSON.stringify([...f.values]);
    for (const sensitive of [issued.cookie, issued.cookie.split("=", 2)[1], password, f.env.ADMIN_USERNAME, f.env.DEBUG_ACCESS_TOKEN,
        issued.body.csrf_token]) assert.ok(!state.includes(sensitive));
    const records = [...f.values.values()].find((value) => Array.isArray(value.items));
    assert.equal(records.items.length, 1);
    assert.deepEqual(Object.keys(records.items[0]).sort(), ["expires_at", "hash"]);
    assert.match(records.items[0].hash, /^[A-Za-z0-9_-]{43}$/);
    const meta = [...f.values.values()].find((value) => typeof value.key === "string");
    assert.match(meta.key, /^[A-Za-z0-9_-]{43}$/);
    const response = await f.check(issued.cookie);
    const publicBody = await response.text();
    for (const sensitive of [meta.key, issued.cookie, password, f.env.ADMIN_USERNAME, f.env.DEBUG_ACCESS_TOKEN])
        assert.ok(!publicBody.includes(sensitive));
    assert.notEqual(issued.body.csrf_token, issued.cookie.split(".").at(-1));
});

test("first login persists its signing key before issuing or storing an active session", async (t) => {
    const f = fixture(t);
    const original = f.storage.put;
    let first = true;
    f.storage.put = async (key, value) => {
        if (first) { first = false; throw new Error("private_persistence_failure"); }
        return original(key, value);
    };
    const response = await f.login();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "STORAGE_UNAVAILABLE" });
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(f.values.size, 0);
    const issued = await f.issue();
    assert.equal(await f.authorize(issued.cookie), true);
    const firstPersisted = f.values.get(f.writes[0]);
    assert.equal(typeof firstPersisted.key, "string");
});

test("missing key with existing records and corrupt key metadata fail closed without rebuilding", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const keyEntry = [...f.values].find(([, value]) => typeof value.key === "string");
    const [keyName, keyValue] = keyEntry;
    for (const value of [undefined, { ...keyValue, key: "corrupt_private_key" }, { ...keyValue, version: 2 },
        { ...keyValue, extra: "private_marker" }]) {
        if (value === undefined) f.values.delete(keyName);
        else f.values.set(keyName, value);
        const before = structuredClone([...f.values]);
        await assert.rejects(f.authorize(issued.cookie), { message: "STATE_INVALID" });
        const response = await f.login();
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: "STATE_INVALID" });
        assert.equal(response.headers.get("Set-Cookie"), null);
        assert.deepEqual([...f.values], before);
    }
});

test("malformed duplicate oversized or secret-bearing session records fail closed", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const [recordKey, valid] = [...f.values].find(([, value]) => Array.isArray(value.items));
    const cases = [null, { version: 9, items: [] }, { ...valid, extra: "private_marker" },
        { ...valid, items: [{ ...valid.items[0], hash: "private_invalid_hash" }] },
        { ...valid, items: [{ ...valid.items[0], expires_at: "123" }] },
        { ...valid, items: [{ ...valid.items[0], cookie: issued.cookie }] },
        { ...valid, items: Array(1) },
        { ...valid, items: [valid.items[0], valid.items[0]] },
        { ...valid, items: Array(129).fill(valid.items[0]) }];
    for (const value of cases) {
        f.values.set(recordKey, value);
        const before = structuredClone([...f.values]);
        await assert.rejects(f.authorize(issued.cookie), { message: "STATE_INVALID" });
        const response = await f.check(issued.cookie);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: "STATE_INVALID" });
        assert.deepEqual([...f.values], before);
    }
});

test("storage reads and namespace outages produce safe errors without granting authorization", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    f.storage.get = async () => { throw new Error(`private_marker ${password}`); };
    await assert.rejects(f.authorize(issued.cookie), { message: "STORAGE_UNAVAILABLE" });
    let response = await f.check(issued.cookie);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "STORAGE_UNAVAILABLE" });
    f.env.SCHEDULES.get = () => { throw new Error(`private_marker ${password}`); };
    await assert.rejects(f.authorize(issued.cookie), { message: "STORAGE_UNAVAILABLE" });
    response = await f.login();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "STORAGE_UNAVAILABLE" });
});

test("failed revocation never clears cookie or reports successful logout", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const original = f.storage.put;
    f.storage.put = async () => { throw new Error("private_revoke_failure"); };
    const response = await f.logout(issued.cookie, issued.body.csrf_token);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "STORAGE_UNAVAILABLE" });
    assert.equal(response.headers.get("Set-Cookie"), null);
    f.storage.put = original;
    assert.equal(await f.authorize(issued.cookie), true);
});

test("failed session persistence leaves no issued cookie and preserves the signing key for recovery", async (t) => {
    const f = fixture(t);
    const original = f.storage.put;
    f.storage.put = async (key, value) => {
        if (Array.isArray(value.items)) throw new Error("private_record_write_failure");
        return original(key, value);
    };
    const response = await f.login();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Set-Cookie"), null);
    const key = structuredClone([...f.values]);
    assert.equal(f.values.size, 1);
    f.storage.put = original;
    const issued = await f.issue();
    assert.deepEqual([...f.values].filter(([, value]) => value.key), key);
    assert.equal(await f.authorize(issued.cookie), true);
});

test("concurrent logins retain independent records and cannot bypass the active-record limit", async (t) => {
    const f = fixture(t);
    const responses = await Promise.all(Array.from({ length: 130 }, () => f.login()));
    assert.equal(responses.filter((response) => response.status === 200).length, 128);
    assert.equal(responses.filter((response) => response.status === 429).length, 2);
    const cookies = responses.filter((response) => response.status === 200)
        .map((response) => response.headers.get("Set-Cookie").split(";", 1)[0]);
    assert.equal(new Set(cookies).size, 128);
    assert.equal(await f.authorize(cookies[0]), true);
    assert.equal(await f.authorize(cookies[127]), true);
});

test("stub requests preserve the actual origin and forward only authentication protocol headers", async (t) => {
    const f = fixture(t);
    const response = await f.login({ "X-Forwarded-Host": "evil.test", "X-Forwarded-Proto": "http", "X-Internal-Authorized": "true" });
    assert.equal(response.status, 200);
    const forwarded = f.requests[0];
    assert.equal(forwarded.url, "https://sessions.test/session/login");
    assert.equal(forwarded.headers.get("Origin"), origin);
    assert.equal(forwarded.headers.get("X-Forwarded-Host"), null);
    assert.equal(forwarded.headers.get("X-Internal-Authorized"), null);
    const cookie = response.headers.get("Set-Cookie").split(";", 1)[0];
    const body = await response.json();
    assert.equal(await f.authorize(cookie, { method: "POST", headers: { Origin: origin,
        "Content-Type": "application/json", "X-CSRF-Token": body.csrf_token }, body: '{"enabled":false}' }), true);
    const check = f.requests.at(-1);
    assert.equal(check.url, "https://sessions.test/session/check");
    assert.equal(check.method, "POST");
    assert.equal(await check.text(), "");
});

test("internal login and logout repeat all authentication checks without trusting an internal bypass", async (t) => {
    const f = fixture(t);
    const response = await sessions.sessionStorageResponse(f.request("/session/login", { method: "POST", body: "{}",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Internal-Authorized": "true" } }),
    f.ctx, f.env, f.basicAuthorized);
    assert.equal(response.status, 401);
    assert.equal(f.values.size, 0);
    const issued = await f.issue();
    const badOrigin = await sessions.sessionStorageResponse(f.request("/session/logout", { method: "POST", body: "{}",
        headers: { Cookie: issued.cookie, Origin: "https://evil.test", "Content-Type": "application/json",
            "X-CSRF-Token": issued.body.csrf_token } }), f.ctx, f.env, f.basicAuthorized);
    assert.equal(badOrigin.status, 403);
    assert.equal(await f.authorize(issued.cookie), true);
});

test("unrelated paths return null while unsupported methods on session routes never access storage", async (t) => {
    const f = fixture(t);
    assert.equal(await f.call("/api/admin/targets"), null);
    assert.equal(await sessions.sessionStorageResponse(f.request("/init"), f.ctx, f.env, f.basicAuthorized), null);
    for (const path of ["/api/admin/session", "/api/admin/session/login", "/api/admin/session/logout"]) {
        const response = await f.call(path, { method: "DELETE" });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { status: "NOT_FOUND" });
    }
    assert.equal(f.names.length, 0);
    assert.equal(f.values.size, 0);
});

test("expiry reached during a storage read cannot authorize the previously valid cookie", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const original = f.storage.get;
    let advanced = false;
    f.storage.get = async (key) => {
        if (!advanced) { advanced = true; f.advance(12 * 60 * 60 * 1000); }
        return original(key);
    };
    const response = await f.check(issued.cookie);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { status: "UNAUTHORIZED" });
    assert.equal(await f.authorize(issued.cookie), false);
});

test("unexpected or oversized object responses are bounded and never forwarded to the browser", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    const bodies = ["private_response_marker", JSON.stringify({ status: "STATE_INVALID", detail: password }),
        JSON.stringify({ status: "AUTHENTICATED", expires_at: issued.body.expires_at, csrf_token: "x".repeat(2048) }),
        JSON.stringify({ status: "AUTHENTICATED", expires_at: issued.body.expires_at, csrf_token: issued.body.csrf_token,
            private_key: "private_response_marker" })];
    for (const body of bodies) {
        f.env.SCHEDULES.get = () => ({ fetch: async () => new Response(body, { status: 200 }) });
        const response = await f.check(issued.cookie);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: "STORAGE_UNAVAILABLE" });
        assert.equal(response.headers.get("Set-Cookie"), null);
        await assert.rejects(f.authorize(issued.cookie), { message: "STORAGE_UNAVAILABLE" });
    }
});

test("missing signing key after all sessions were revoked cannot silently restart the key lineage", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    assert.equal((await f.logout(issued.cookie, issued.body.csrf_token)).status, 200);
    const [keyName] = [...f.values].find(([, value]) => typeof value.key === "string");
    f.values.delete(keyName);
    const before = structuredClone([...f.values]);
    const response = await f.login();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "STATE_INVALID" });
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.deepEqual([...f.values], before);
});

test("a missing CSRF token preserves a protocol rejection without invalidating the existing session", async (t) => {
    const f = fixture(t);
    const issued = await f.issue();
    await assert.rejects(f.authorize(issued.cookie, { method: "POST", body: '{"enabled":false}',
        headers: { Origin: origin, "Content-Type": "application/json" } }), { message: "CSRF_REJECTED" });
    assert.equal(await f.authorize(issued.cookie), true);
    assert.equal(await f.authorize("invalid"), false);
});
