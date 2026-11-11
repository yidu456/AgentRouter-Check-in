import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import worker, { TriggerSchedule } from "../src/worker.mjs";

crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const auth = "Basic " + Buffer.from("admin:dummy-long-secret-for-tests").toString("base64");
const schedule = { mode: "fixed", times: ["09:00"] };
const legacy = { id: "a", repository: "owner/repo", ref: "main", workflow: "Checkin.yml",
    token_secret: "PRIVATE_TOKEN", enabled: true, schedule };
const edited = { ...legacy, name: "Daily", token_secret: "GITHUB_TOKEN", schedule };

function fixture(t, raw = JSON.stringify({ version: 1, targets: [legacy] })) {
    let now = Date.parse("2026-11-11T00:05:00+08:00");
    const contexts = new Map(), objects = new Map();
    const env = { TRIGGER_CONFIG: raw, DEBUG_ACCESS_TOKEN: "dummy_access_" + "x".repeat(40),
        ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "dummy-long-secret-for-tests",
        GITHUB_TOKEN: "github_pat_dummy_tests", PRIVATE_TOKEN: "private_pat_dummy_tests",
        GITHUB_TOKEN_B: "github_pat_dummy_b", GITHUB_TOKEN_BAD: "bad value" };
    env.SCHEDULES = { idFromName: id => id, get(id) {
        if (!contexts.has(id)) {
            const values = new Map();
            let alarm = null, queue = Promise.resolve();
            const storage = { values, async get(key) { return structuredClone(values.get(key)); },
                async put(key, value) { for (const [k, v] of Object.entries(typeof key === "string" ? { [key]: value } : key))
                    values.set(k, structuredClone(v)); },
                async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; } };
            contexts.set(id, { storage, blockConcurrencyWhile(fn) { const p = queue.then(fn); queue = p.catch(() => {}); return p; } });
        }
        if (!objects.has(id)) objects.set(id, new TriggerSchedule(contexts.get(id), env));
        return objects.get(id);
    } };
    t.mock.method(Date, "now", () => now);
    t.mock.method(console, "log", () => {});
    const http = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    const call = (path = "/api/admin/catalog", body, headers = {}) => worker.fetch(new Request("https://unit.test" + path,
        { method: body === undefined ? "GET" : "POST", headers: { Authorization: auth,
            ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: "https://unit.test" }), ...headers },
            ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), env);
    const read = async () => (await (await call("/api/admin/targets")).json()).targets;
    const save = (target = edited, revision = 0) => call("/api/admin/catalog", { revision, target });
    const storage = id => { env.SCHEDULES.get(id); return contexts.get(id).storage; };
    return { env, call, read, save, http, storage, object: id => env.SCHEDULES.get(id),
        restart() { objects.clear(); }, setNow(value) { now = typeof value === "number" ? value : Date.parse(value); } };
}

test("catalog imports once, preserves legacy override and persists without variable after restart", async t => {
    const f = fixture(t);
    await f.call("/api/admin/targets/a/enabled", { enabled: false });
    f.env["GITHUB_TOKEN_" + "A".repeat(64)] = "github_pat_dummy_longref";
    const before = (await f.read())[0];
    const imported = await f.call();
    assert.equal(imported.status, 200);
    const catalog = await imported.json();
    assert.equal(catalog.revision, 0);
    assert.equal(catalog.items[0].name, "a");
    assert.deepEqual(catalog.credentials, ["GITHUB_TOKEN", "GITHUB_TOKEN_B", "PRIVATE_TOKEN"]);
    assert.ok(!JSON.stringify(catalog).includes(f.env.GITHUB_TOKEN));
    delete f.env.TRIGGER_CONFIG;
    f.restart();
    const after = (await f.read())[0];
    assert.equal(after.enabled, false);
    assert.equal(after.next_run, before.next_run);
    assert.equal(f.http.mock.callCount(), 0);
});

test("empty setup creates a stable new target, updates only it and rejects stale writes", async t => {
    const f = fixture(t, undefined);
    delete f.env.TRIGGER_CONFIG;
    assert.deepEqual((await (await f.call()).json()).items, []);
    const { id, ...target } = edited;
    const response = await f.save(target);
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.status, "CATALOG_UPDATED");
    assert.match(saved.target.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(saved.revision, 1);
    assert.ok((await f.read())[0].next_run);
    assert.equal((await f.save({ ...saved.target, ref: "dev-plus" }, 0)).status, 409);
    const updated = await f.save({ ...saved.target, ref: "dev-plus" }, 1);
    assert.equal(updated.status, 200);
    f.restart();
    assert.equal((await f.read())[0].ref, "dev-plus");
    assert.equal(f.http.mock.callCount(), 0);
});

test("catalog validates trust boundaries without exposing rejected values", async t => {
    const f = fixture(t);
    await f.call();
    for (const changes of [{ repository: "https://private.example/secret" }, { workflow: "../secret.yml" },
        { ref: "../private" }, { name: "x".repeat(65) }, { token_secret: "ADMIN_PASSWORD" },
        { token_secret: "GITHUB_TOKEN_BAD" }, { token_secret: "OTHER_SECRET" }, { enabled: "yes" },
        { unexpected: "private_marker" }]) {
        const response = await f.save({ ...edited, ...changes });
        assert.equal(response.status, 400);
        assert.ok(!(await response.text()).includes("private_marker"));
    }
    assert.equal((await f.call("/api/admin/catalog", { revision: 0, target: edited }, { Origin: "https://evil.test" })).status, 403);
    assert.equal((await f.call("/api/admin/catalog", "x".repeat(1025))).status, 413);
    assert.equal((await f.call("/api/admin/catalog", undefined, { Authorization: "" })).status, 401);
    assert.equal(f.http.mock.callCount(), 0);
});

test("malformed bootstrap and corrupt catalog fail closed, never fall back to variable", async t => {
    const f = fixture(t, "bad");
    assert.equal((await f.call()).status, 503);
    f.env.TRIGGER_CONFIG = JSON.stringify({ version: 1, targets: [legacy] });
    assert.equal((await f.call()).status, 200);
    f.storage("catalog:v1").values.set("target_catalog", { version: 1, revision: -1, items: [] });
    assert.equal((await f.call()).status, 503);
    assert.equal((await f.call("/api/admin/targets")).status, 503);
    await worker.scheduled({}, f.env);
    assert.equal(f.http.mock.callCount(), 0);
});

test("identity edit invalidates the old Alarm and receipts never transfer to new destination", async t => {
    const f = fixture(t);
    await f.call();
    await f.read();
    const request_id = "00000000-0000-4000-8000-000000000001";
    await f.call("/api/admin/targets/a/run", { request_id });
    const guardBinding = JSON.stringify(["a", JSON.stringify(["owner/repo", "Checkin.yml", "main"])]);
    f.storage("v1:a").values.set("automatic_guard", { version: 1, binding: guardBinding, last_at: Date.now() });
    assert.equal((await f.save({ ...edited, ref: "dev-plus" })).status, 200);
    assert.equal((await f.call("/api/admin/targets/a/run", { request_id })).status, 409);
    const state = (await f.read())[0];
    assert.equal(state.automatic_state, "unknown");
    assert.equal(state.history.length, 1);
    assert.equal(f.storage("v1:a").values.get("receipts").items.length, 1);
    await f.object("v1:a").alarm();
    assert.equal(f.http.mock.callCount(), 1);
    f.setNow(Date.parse(state.next_run));
    await f.object("v1:a").alarm();
    assert.equal(f.http.mock.callCount(), 2);
    assert.equal(JSON.parse(f.http.mock.calls[1].arguments[1].body).ref, "dev-plus");
});

test("same-identity edit adopts schedule and enabled while preserving automatic guard", async t => {
    const f = fixture(t);
    await f.call();
    await f.read();
    const identity = JSON.stringify(["a", JSON.stringify(["owner/repo", "Checkin.yml", "main"])]);
    f.storage("v1:a").values.set("schedule_settings", { version: 1, binding: identity, revision: 1,
        schedule: { mode: "fixed", times: ["18:00"] } });
    f.storage("v1:a").values.set("automatic_guard", { version: 1, binding: identity, last_at: Date.now() });
    await f.save({ ...edited, schedule: { mode: "fixed", times: ["10:00"], min_interval_minutes: 2880 } });
    const state = (await f.read())[0];
    assert.deepEqual(state.schedule, { mode: "fixed", times: ["10:00"], min_interval_minutes: 2880 });
    assert.equal(state.schedule_source, "database");
    assert.equal(state.automatic_state, "known");
    assert.ok(Date.parse(state.next_run) >= Date.parse(state.automatic_next_allowed_at));
    assert.equal(f.http.mock.callCount(), 0);
});

test("catalog single-key failed commit leaves previous target and rejects competing revisions", async t => {
    const f = fixture(t);
    await f.call();
    const responses = await Promise.all([f.save(edited), f.save({ ...edited, name: "Second" })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const storage = f.storage("catalog:v1");
    t.mock.method(storage, "put", async () => { throw new Error("private error"); });
    assert.equal((await f.save({ ...edited, ref: "next" }, 1)).status, 503);
    assert.equal((await f.read())[0].ref, "main");
});

test("health reflects database definitions instead of missing or outdated variable", async t => {
    const f = fixture(t);
    await f.call();
    await f.save(edited);
    f.env.TRIGGER_CONFIG = "invalid old variable";
    const health = await (await f.call("/health")).json();
    assert.equal(health.config.state, "valid");
    assert.equal(health.config.source, "database");
    assert.equal(health.targets.total, 1);
});

test("two-day automatic gap plans the next eligible date without daily skipped attempts", async t => {
    const f = fixture(t);
    await f.call();
    await f.save({ ...edited, schedule: { mode: "fixed", times: ["09:00"], min_interval_minutes: 2880 } });
    const first = (await f.read())[0];
    f.setNow(first.next_run);
    await f.object("v1:a").alarm();
    const second = (await f.read())[0];
    assert.equal(Date.parse(second.next_run) - Date.parse(first.next_run), 2 * 86400_000);
    f.setNow(Date.parse(first.next_run) + 86400_000);
    await worker.scheduled({}, f.env);
    await f.object("v1:a").alarm();
    assert.equal(f.http.mock.callCount(), 1);
    f.setNow(second.next_run);
    await f.object("v1:a").alarm();
    assert.equal(f.http.mock.callCount(), 2);
});

test("managed enable changes catalog revision and blocks stale editor overwrite", async t => {
    const f = fixture(t);
    await f.call();
    const identity = JSON.stringify(["a", JSON.stringify(["owner/repo", "Checkin.yml", "main"])]);
    f.storage("v1:a").values.set("schedule_settings", { version: 1, binding: identity, revision: 1,
        schedule: { mode: "fixed", times: ["18:00"] } });
    const response = await f.call("/api/admin/targets/a/enabled", { enabled: false });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).target.enabled, false);
    assert.deepEqual((await f.read())[0].schedule, { mode: "fixed", times: ["18:00"] });
    assert.equal((await (await f.call()).json()).revision, 1);
    assert.equal((await f.save(edited, 0)).status, 409);
    const binding = JSON.stringify(["a", JSON.stringify(["owner/repo", "Checkin.yml", "main"])]);
    assert.equal((await f.call("/api/admin/targets/a/schedule", { binding, revision: 1, schedule })).status, 409);
    assert.equal(f.http.mock.callCount(), 0);
});

for (const first of ["cron", "alarm"]) test(`saved reopen never catches up an elapsed slot when ${first} adopts it first`, async t => {
    const f = fixture(t);
    await f.call();
    await f.read();
    await f.call("/api/admin/targets/a/enabled", { enabled: false });
    f.setNow("2026-11-11T10:00:00+08:00");
    await f.save(edited, 1);
    if (first === "cron") await worker.scheduled({}, f.env);
    await f.object("v1:a").alarm();
    assert.equal(f.http.mock.callCount(), 0);
    assert.equal((await f.read())[0].next_run, "2026-11-12T01:00:00.000Z");
    f.restart();
    await f.object("v1:a").alarm();
    assert.equal(f.http.mock.callCount(), 0);
});

test("health accepts the bounded catalog capacity without the legacy variable size limit", async t => {
    const f = fixture(t);
    await f.call();
    const catalog = f.storage("catalog:v1").values.get("target_catalog");
    catalog.items = Array.from({ length: 100 }, (_, index) => ({ ...catalog.items[0], id: "t" + index,
        repository: "a".repeat(99) + "/" + "r".repeat(96) + index,
        workflow: "w".repeat(99) + ".yaml", ref: "b".repeat(199), name: "n".repeat(64),
        token_secret: "GITHUB_TOKEN_" + "A".repeat(50), enabled: false }));
    assert.ok(JSON.stringify(catalog).length > 64000);
    const response = await f.call("/health");
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.config.state, "valid");
    assert.equal(health.targets.total, 100);
});

test("failed adoption cannot consume future-only reconciliation or recovered historical guard", async t => {
    const f = fixture(t);
    await f.call();
    const state = (await f.read())[0];
    f.setNow(state.next_run);
    await f.object("v1:a").alarm();
    const storage = f.storage("v1:a");
    storage.values.delete("automatic_guard");
    const record = storage.values.get("history").items[0];
    const previous = storage.values.get("plan");
    previous.slots[0] = { ...previous.slots[0], at: record.at, attempted: true, result: record.result,
        history_id: record.id, notification: record.notification };
    previous.date = "2026-11-11";
    const before = structuredClone([...storage.values.entries()]);
    await f.save({ ...edited, schedule: { mode: "fixed", times: ["09:00"], min_interval_minutes: 2880 } });
    const put = storage.put;
    storage.put = async () => { throw new Error("private failure"); };
    assert.equal((await f.read())[0].error, "STORAGE_UNAVAILABLE");
    assert.deepEqual([...storage.values.entries()], before);
    storage.put = put;
    f.restart();
    const restored = (await f.read())[0];
    assert.equal(restored.automatic_state, "known");
    assert.ok(Date.parse(restored.next_run) >= record.at + 2880 * 60000);
    assert.equal(f.http.mock.callCount(), 1);
});

test("reserved legacy credential reference rejects bootstrap before storing an uneditable catalog", async t => {
    const f = fixture(t, JSON.stringify({ version: 1, targets: [{ ...legacy, enabled: false, token_secret: "ADMIN_PASSWORD" }] }));
    const response = await f.call();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, "CONFIG_INVALID");
    assert.equal(f.storage("catalog:v1").values.has("target_catalog"), false);
    f.env.TRIGGER_CONFIG = JSON.stringify({ version: 1, targets: [legacy] });
    assert.equal((await f.call()).status, 200);
    assert.equal(f.http.mock.callCount(), 0);
});
