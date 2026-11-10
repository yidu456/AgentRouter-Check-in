import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import worker, { TriggerSchedule } from "../src/worker.mjs";
import { validSettings, validGuard, effectiveTarget, settingsState, settingsBinding } from "../src/schedule-settings.mjs";

crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const credentials = "Basic " + Buffer.from("admin:dummy-long-secret-for-tests").toString("base64");
const fixed = { mode: "fixed", times: ["09:00", "18:00"], min_interval_minutes: 120 };
const binding = JSON.stringify(["a", JSON.stringify(["owner/repo", "Checkin.yml", "main"])]);
const uuid = "00000000-0000-4000-8000-000000000001";

function fixture(t, options = {}) {
    let now = Date.parse(options.now ?? "2026-11-08T00:05:00+08:00"), alarm = null, queue = Promise.resolve();
    const values = new Map(), batches = [];
    const storage = { async get(key) { return structuredClone(values.get(key)); },
        async put(key, value) {
            const batch = structuredClone(typeof key === "string" ? { [key]: value } : key);
            batches.push(batch);
            for (const [name, saved] of Object.entries(batch)) values.set(name, saved);
        }, async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; } };
    const ctx = { storage, blockConcurrencyWhile(fn) { const p = queue.then(fn); queue = p.catch(() => {}); return p; } };
    const target = { id: "a", repository: "owner/repo", workflow: "Checkin.yml", ref: "main",
        token_secret: "GITHUB_TOKEN_A", enabled: options.enabled ?? true,
        ...(options.schedule === null ? {} : { schedule: options.schedule ?? fixed }) };
    const env = { TRIGGER_CONFIG: JSON.stringify({ version: 1, targets: [target] }),
        GITHUB_TOKEN_A: "github_pat_dummy_tests", DEBUG_ACCESS_TOKEN: "dummy_access_" + "x".repeat(40),
        ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "dummy-long-secret-for-tests" };
    let object = new TriggerSchedule(ctx, env);
    env.SCHEDULES = { idFromName: id => id, get: () => object };
    t.mock.method(Date, "now", () => now);
    t.mock.method(console, "log", () => {});
    const http = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    const call = (path = "", body, headers = {}) => worker.fetch(new Request("https://unit.test/api/admin/targets" + path,
        { method: body === undefined ? "GET" : "POST", headers: { Authorization: credentials,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
            ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), env);
    const read = async () => (await (await call()).json()).targets[0];
    const save = (schedule, revision = 0, identity = binding) => call("/a/schedule", { binding: identity, revision, schedule });
    const reset = (revision, identity = binding) => call("/a/schedule/reset", { binding: identity, revision });
    return { env, ctx, storage, values, batches, http, call, read, save, reset, alarm: () => alarm,
        object: () => object, restart() { object = new TriggerSchedule(ctx, env); },
        setNow(value) { now = typeof value === "number" ? value : Date.parse(value); },
        config(changes) { Object.assign(target, changes); env.TRIGGER_CONFIG = JSON.stringify({ version: 1, targets: [target] }); } };
}

test("settings persist atomically, take precedence after restart, and reset keeps revision tombstone", async t => {
    const f = fixture(t);
    const before = await f.read();
    assert.equal(before.target_binding, binding);
    assert.equal(before.schedule_source, "variable");
    assert.equal(before.schedule_revision, 0);
    const saved = await f.save({ mode: "fixed", times: ["20:00", "10:00"], min_interval_minutes: 120 });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).status, "SCHEDULE_UPDATED");
    assert.equal(f.values.get("schedule_settings").revision, 1);
    assert.ok(f.batches.some(batch => batch.schedule_settings && batch.plan));
    f.config({ schedule: { mode: "fixed", times: ["08:00"] } });
    f.restart();
    const actual = await f.read();
    assert.deepEqual(actual.schedule, { mode: "fixed", times: ["10:00", "20:00"], min_interval_minutes: 120 });
    assert.equal(actual.schedule_source, "database");
    assert.equal(actual.schedule_revision, 1);
    assert.equal((await f.reset(1)).status, 200);
    assert.equal(f.values.get("schedule_settings").schedule, null);
    assert.equal((await f.read()).schedule_revision, 2);
    assert.deepEqual((await f.read()).schedule, { mode: "fixed", times: ["08:00"] });
    assert.equal(f.http.mock.callCount(), 0);
});

test("concurrent revision writes cannot overwrite each other or stale reset", async t => {
    const f = fixture(t);
    await f.read();
    const responses = await Promise.all([f.save(fixed), f.save({ mode: "fixed", times: ["11:00"] })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    assert.equal(f.values.get("schedule_settings").revision, 1);
    const stale = await f.reset(0);
    assert.deepEqual(await stale.json(), { status: "SCHEDULE_CONFLICT" });
    assert.equal(f.http.mock.callCount(), 0);
});

test("identity changes discard override and guard without transferring revisions", async t => {
    const f = fixture(t);
    await f.save(fixed);
    f.values.set("automatic_guard", { version: 1, binding, last_at: Date.now() });
    f.config({ ref: "other" });
    const state = await f.read();
    assert.equal(state.schedule_revision, 0);
    assert.equal(state.schedule_source, "variable");
    assert.equal(state.automatic_state, "unknown");
    const response = await f.save(fixed, 1);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { status: "TARGET_CHANGED" });
});

test("same canonical random save and repeated reset preserve plan without redraw", async t => {
    const schedule = { mode: "random", count: 3, window: { start: "09:00", end: "22:00" } };
    const f = fixture(t, { schedule });
    await f.read();
    const before = structuredClone(f.values.get("plan"));
    assert.equal((await f.save({ ...schedule, window: { end: "22:00", start: "09:00" }, min_interval_minutes: 1 })).status, 200);
    assert.deepEqual(f.values.get("plan"), before);
    assert.equal((await f.reset(1)).status, 200);
    assert.deepEqual(f.values.get("plan"), before);
    assert.equal((await f.reset(2)).status, 200);
    assert.equal(f.values.get("schedule_settings").revision, 3);
    assert.deepEqual(f.values.get("plan"), before);
});

test("API rejects unknown fields, unsafe revisions, invalid schedules, origin and oversized UTF8 safely", async t => {
    const f = fixture(t);
    for (const body of [{ binding, revision: -1, schedule: fixed }, { binding, revision: 0.5, schedule: fixed },
        { binding, revision: "0", schedule: fixed }, { binding, revision: 0, schedule: fixed, secret: "private_marker" },
        { binding, revision: 0 }]) {
        assert.equal((await f.call("/a/schedule", body)).status, 400);
    }
    const bad = await f.save({ mode: "fixed", times: ["09:00", "10:00"], min_interval_minutes: 120 });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { status: "SCHEDULE_INVALID", error: { field: "schedule.times", code: "SCHEDULE_SPACING" } });
    assert.equal((await f.call("/a/schedule/reset", { binding, revision: 0, schedule: null })).status, 400);
    assert.equal((await f.call("/a/schedule", { binding, revision: 0, schedule: fixed }, { Origin: "https://evil.test" })).status, 403);
    assert.equal((await f.call("/a/schedule", " ".repeat(1025))).status, 413);
    assert.equal((await f.save(fixed, 0, "x".repeat(1025))).status, 413);
    assert.equal((await f.call("/a/schedule", '"' + "\u00e9".repeat(600) + '"', { "Content-Length": "1" })).status, 413);
    assert.equal(f.values.has("schedule_settings"), false);
    assert.equal(f.http.mock.callCount(), 0);
});

test("revision exhaustion refuses saves and reset without wrapping", async t => {
    const f = fixture(t);
    f.values.set("schedule_settings", { version: 1, binding, revision: Number.MAX_SAFE_INTEGER, schedule: fixed });
    for (const response of [await f.save(fixed, Number.MAX_SAFE_INTEGER), await f.reset(Number.MAX_SAFE_INTEGER)]) {
        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), { status: "SCHEDULE_REVISION_LIMIT" });
    }
});

for (const reason of ["disabled", "missing-token"]) {
    test(`${reason} still saves settings without arming or dispatch`, async t => {
        const f = fixture(t, { enabled: reason !== "disabled" });
        if (reason === "missing-token") delete f.env.GITHUB_TOKEN_A;
        assert.equal((await f.save(fixed)).status, 200);
        assert.equal(f.alarm(), null);
        assert.equal(f.values.get("schedule_settings").revision, 1);
        assert.equal(f.http.mock.callCount(), 0);
    });
    test(`${reason} read repairs failed postcommit Alarm removal without losing persisted settings or plan`, async t => {
        const f = fixture(t);
        await f.read();
        if (reason === "disabled") f.config({ enabled: false });
        else delete f.env.GITHUB_TOKEN_A;
        const remove = f.storage.deleteAlarm;
        f.storage.deleteAlarm = async () => { throw new Error("private_alarm_error"); };
        assert.equal((await f.save({ mode: "fixed", times: ["11:00"] })).status, 503);
        const committed = structuredClone(f.values.get("plan"));
        assert.equal(f.values.get("schedule_settings").revision, 1);
        assert.notEqual(f.alarm(), null);
        f.storage.deleteAlarm = remove;
        f.restart();
        const actual = await f.read();
        assert.equal(actual.schedule_revision, 1);
        assert.deepEqual(f.values.get("plan"), committed);
        assert.equal(f.alarm(), null);
        assert.equal(f.http.mock.callCount(), 0);
    });
}

test("atomic settings failure changes neither revision nor plan; alarm failure reads committed revision and time", async t => {
    const f = fixture(t);
    await f.read();
    const before = structuredClone(f.values.get("plan")), put = f.storage.put, arm = f.storage.setAlarm;
    f.storage.put = async (key, value) => {
        if (typeof key === "object" && key.schedule_settings) throw new Error("private_atomic_error");
        return put(key, value);
    };
    assert.equal((await f.save({ mode: "fixed", times: ["11:00"] })).status, 503);
    assert.equal(f.values.has("schedule_settings"), false);
    assert.deepEqual(f.values.get("plan"), before);
    f.storage.put = put;
    f.storage.setAlarm = async () => { throw new Error("private_alarm_error"); };
    assert.equal((await f.save({ mode: "fixed", times: ["11:00"] })).status, 503);
    const committed = structuredClone(f.values.get("plan"));
    assert.equal(f.values.get("schedule_settings").revision, 1);
    f.storage.setAlarm = arm;
    f.restart();
    const actual = await f.read();
    assert.equal(actual.schedule_revision, 1);
    assert.deepEqual(f.values.get("plan"), committed);
    assert.equal(f.alarm(), Date.parse("2026-11-08T11:00:00+08:00"));
    assert.equal(f.http.mock.callCount(), 0);
});

test("persisted settings reject sparse canonical arrays rather than reaching planner with holes", async t => {
    const f = fixture(t);
    f.values.set("schedule_settings", { version: 1, binding, revision: 1,
        schedule: { mode: "fixed", times: Array(1) } });
    const state = await f.read();
    assert.equal(state.error, "STATE_INVALID");
    assert.equal(f.values.has("plan"), false);
});

test("rejected identity or revision cannot write a recovered guard before settings validation", async t => {
    const f = fixture(t);
    await f.read();
    const plan = f.values.get("plan");
    plan.slots[0] = { ...plan.slots[0], attempted: true, result: "DISPATCH_UNKNOWN", history_id: uuid };
    f.values.set("history", { version: 1, items: [{ id: uuid, at: Date.now(), source: "automatic",
        result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" }] });
    const writes = f.batches.length;
    assert.equal((await f.save(fixed, 1)).status, 409);
    assert.equal(f.values.has("automatic_guard"), false);
    assert.equal(f.batches.length, writes);
    assert.equal((await f.save(fixed, 0, "stale-binding")).status, 409);
    assert.equal(f.values.has("automatic_guard"), false);
    assert.equal(f.batches.length, writes);
    assert.equal((await f.save(fixed)).status, 200);
    assert.ok(f.batches.at(-1).automatic_guard);
});

test("save after fixed past times and random window never catches up", async t => {
    const f = fixture(t, { now: "2026-11-08T13:00:00+08:00" });
    assert.equal((await f.save(fixed)).status, 200);
    assert.equal(f.alarm(), Date.parse("2026-11-08T18:00:00+08:00"));
    assert.equal(f.values.get("plan").slots[0].result, "MISSED_DATE");
    assert.equal((await f.save({ mode: "random", count: 2, window: { start: "09:00", end: "22:00" } }, 1)).status, 200);
    assert.equal(f.values.get("plan").date, "2026-11-09");
    assert.equal(f.http.mock.callCount(), 0);
});

for (const outcome of ["accepted", "failure", "unknown"]) {
    test(`actual ${outcome} attempt checkpoints before HTTP and late second slot skips until minimum interval`, async t => {
        const f = fixture(t);
        await f.read();
        assert.equal((await f.read()).automatic_state, "unknown");
        f.setNow("2026-11-08T17:00:00+08:00");
        f.http.mock.mockImplementation(async () => {
            assert.equal(f.values.get("automatic_guard").last_at, Date.parse("2026-11-08T17:00:00+08:00"));
            assert.equal(f.values.get("history").items[0].result, "DISPATCH_UNKNOWN");
            assert.equal(f.values.get("plan").slots[0].result, "DISPATCH_UNKNOWN");
            f.setNow("2026-11-08T17:10:00+08:00");
            if (outcome === "unknown") throw new Error("private_network_error");
            return new Response(null, { status: outcome === "accepted" ? 204 : 500 });
        });
        await f.object().alarm();
        assert.ok(f.batches.some(batch => batch.automatic_guard && batch.plan && batch.history));
        const state = await f.read();
        assert.equal(state.automatic_state, "known");
        assert.equal(state.automatic_last_at, "2026-11-08T09:00:00.000Z");
        assert.equal(state.automatic_next_allowed_at, "2026-11-08T11:00:00.000Z");
        f.setNow("2026-11-08T18:00:00+08:00");
        await f.object().alarm();
        assert.equal(f.http.mock.callCount(), 1);
        assert.equal(f.values.get("plan").last.result, "INTERVAL_SKIPPED");
        assert.equal(f.values.get("history").items.length, 1);
        assert.equal(f.values.get("automatic_guard").last_at, Date.parse("2026-11-08T17:00:00+08:00"));
        const rolled = await f.read();
        assert.equal(rolled.schedule_date, "2026-11-09");
        assert.ok(rolled.slots.every(slot => slot.result === "PLANNED" && !slot.attempted));
        assert.deepEqual(rolled.schedule_last, { date: "2026-11-08", at: "2026-11-08T10:00:00.000Z", result: "INTERVAL_SKIPPED" });
        assert.equal(rolled.history.length, 1);
    });
}

test("single daily interval skip remains public after rollover and restart without dispatch history", async t => {
    const f = fixture(t, { schedule: { mode: "fixed", times: ["09:00"], min_interval_minutes: 1440 } });
    assert.equal(Object.hasOwn(await f.read(), "schedule_last"), false);
    f.setNow("2026-11-08T23:00:00+08:00");
    await f.object().alarm();
    assert.equal(f.http.mock.callCount(), 1);
    await f.call("/a/logs/clear", {});
    const guard = structuredClone(f.values.get("automatic_guard"));
    f.setNow("2026-11-09T09:00:00+08:00");
    await f.object().alarm();
    f.restart();
    const state = await f.read();
    assert.equal(state.schedule_date, "2026-11-10");
    assert.deepEqual(state.slots, [{ at: "2026-11-10T01:00:00.000Z", attempted: false, result: "PLANNED" }]);
    assert.deepEqual(state.schedule_last, { date: "2026-11-09", at: "2026-11-09T01:00:00.000Z", result: "INTERVAL_SKIPPED" });
    assert.deepEqual(state.history, []);
    assert.equal(f.http.mock.callCount(), 1);
    assert.deepEqual(f.values.get("automatic_guard"), guard);
    assert.equal(f.alarm(), Date.parse("2026-11-10T09:00:00+08:00"));
});

test("guard persists through settings/reset/pause/log clear and enforces tomorrow spacing independently of manual", async t => {
    const f = fixture(t, { schedule: { mode: "fixed", times: ["09:00"], min_interval_minutes: 1440 } });
    await f.read();
    f.setNow("2026-11-08T23:00:00+08:00");
    await f.object().alarm();
    const guard = structuredClone(f.values.get("automatic_guard"));
    assert.equal((await f.save({ mode: "fixed", times: ["09:00"], min_interval_minutes: 1440 })).status, 200);
    assert.equal((await f.reset(1)).status, 200);
    assert.equal((await f.call("/a/enabled", { enabled: false })).status, 200);
    assert.equal((await f.call("/a/logs/clear", {})).status, 200);
    assert.equal((await f.call("/a/enabled", { enabled: true })).status, 200);
    assert.deepEqual(f.values.get("automatic_guard"), guard);
    assert.equal((await f.call("/a/run", { request_id: uuid })).status, 200);
    assert.deepEqual(f.values.get("automatic_guard"), guard);
    f.setNow("2026-11-09T09:00:00+08:00");
    f.restart();
    await f.object().alarm();
    assert.equal(f.http.mock.callCount(), 2);
    assert.equal(f.values.get("plan").last.result, "INTERVAL_SKIPPED");
    assert.deepEqual(f.values.get("automatic_guard"), guard);
});

for (const phase of ["before", "after"]) {
    test(`${phase}-HTTP atomic failure retains honest checkpoint and never resends a committed attempt`, async t => {
        const f = fixture(t);
        await f.read();
        f.setNow("2026-11-08T09:00:00+08:00");
        const before = structuredClone(f.values.get("plan")), put = f.storage.put;
        f.storage.put = async (key, value) => {
            const batch = typeof key === "object" ? key : { [key]: value };
            if (batch.plan && batch.history && batch.automatic_guard
                && batch.history.items[0].result === (phase === "before" ? "DISPATCH_UNKNOWN" : "DISPATCH_ACCEPTED"))
                throw new Error("private_atomic_failure");
            return put(key, value);
        };
        await assert.rejects(() => f.object().alarm());
        assert.equal(f.http.mock.callCount(), phase === "before" ? 0 : 1);
        if (phase === "before") {
            assert.deepEqual(f.values.get("plan"), before);
            assert.equal(f.values.has("automatic_guard"), false);
            assert.equal(f.values.has("history"), false);
        } else {
            assert.equal(f.values.get("plan").slots[0].result, "DISPATCH_UNKNOWN");
            assert.equal(f.values.get("history").items[0].result, "DISPATCH_UNKNOWN");
            assert.equal(f.values.get("automatic_guard").last_at, Date.now());
        }
        f.storage.put = put;
        f.restart();
        await f.object().alarm();
        await f.object().alarm();
        assert.equal(f.http.mock.callCount(), 1);
    });
}

test("only identity-linked automatic history recovers a missing guard, using latest actual timestamp", async t => {
    const f = fixture(t);
    await f.read();
    const plan = f.values.get("plan"), at = Date.parse("2026-11-08T20:00:00+08:00");
    f.setNow("2026-11-08T20:30:00+08:00");
    const second = uuid.replace(/1$/, "2");
    plan.slots[0] = { ...plan.slots[0], attempted: true, result: "DISPATCH_UNKNOWN", history_id: uuid };
    plan.slots[1] = { ...plan.slots[1], attempted: true, result: "DISPATCH_UNKNOWN", history_id: second };
    f.values.set("history", { version: 1, items: [{ id: uuid, at: at - 10 * 60 * 60_000, source: "automatic",
        result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" }, { id: second, at, source: "automatic",
        result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" }] });
    const state = await f.read();
    assert.equal(state.automatic_last_at, "2026-11-08T12:00:00.000Z");
    assert.equal(f.values.get("automatic_guard").last_at, at);
    await f.call("/a/logs/clear", {});
    assert.equal((await f.read()).automatic_last_at, state.automatic_last_at);
});

test("legacy default initialization recovers linked automatic history before migrating away its slot", async t => {
    const f = fixture(t, { schedule: null });
    f.values.set("plan", { version: 1, id: "a", binding: '["owner/repo","Checkin.yml","main"]',
        date: "2026-11-07", at: Date.parse("2026-11-07T09:00:00+08:00"), attempted: true,
        result: "DISPATCH_UNKNOWN", history_id: uuid, notification: "NOTIFY_UNKNOWN" });
    f.values.set("history", { version: 1, items: [{ id: uuid, at: Date.parse("2026-11-07T09:10:00+08:00"),
        source: "automatic", result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" }] });
    await f.object().fetch(new Request("https://scheduler.internal/init?id=a", { method: "POST" }));
    assert.equal((await f.read()).automatic_last_at, "2026-11-07T01:10:00.000Z");
    assert.equal(f.values.get("plan").version, 2);
    assert.equal(f.values.get("plan").date, "2026-11-08");
    assert.equal(f.http.mock.callCount(), 0);
});

test("settings validators reject noncanonical or unbounded persisted records and preserve absent defaults", () => {
    const base = { version: 1, binding, revision: 1, schedule: fixed };
    assert.equal(validSettings(base), true);
    assert.equal(validSettings({ ...base, schedule: null }), true);
    for (const bad of [null, [], { ...base, version: 2 }, { ...base, revision: 0 },
        { ...base, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...base, revision: true },
        { ...base, binding: "x".repeat(1025) }, { ...base, extra: true }, { ...base, schedule: null, extra: true },
        { ...base, schedule: { mode: "fixed", times: ["18:00", "09:00"] } },
        { ...base, schedule: { mode: "fixed", times: ["09:00"], min_interval_minutes: 1 } },
        { ...base, schedule: { mode: "fixed", times: ["09:00"], count: 1 } },
        { ...base, schedule: { mode: "random", count: 3, window: { start: "09:00", end: "10:00" }, min_interval_minutes: 60 } }])
        assert.equal(validSettings(bad), false);
    const guard = { version: 1, binding, last_at: 0 };
    assert.equal(validGuard(guard), true);
    for (const bad of [null, { ...guard, last_at: -1 }, { ...guard, last_at: true },
        { ...guard, last_at: Number.MAX_SAFE_INTEGER + 1 }, { ...guard, last_at: 8_640_000_000_000_001 },
        { ...guard, last_at: 1.5 }, { ...guard, binding: 1 }, { ...guard, binding: "x".repeat(1025) },
        { ...guard, version: 2 }, { ...guard, extra: true }]) assert.equal(validGuard(bad), false);
    const target = { id: "a", repository: "OWNER/REPO", workflow: "Checkin.yml", ref: "main" };
    assert.equal(settingsBinding(target), binding);
    assert.equal(Object.hasOwn(effectiveTarget(target), "schedule"), false);
    assert.equal(Object.hasOwn(effectiveTarget(target, { ...base, schedule: null }), "schedule"), false);
    assert.deepEqual(effectiveTarget(target, base).schedule, fixed);
    assert.deepEqual(settingsState(target, { ...base, binding: "other" }), {
        schedule_source: "variable", schedule_revision: 0, target_binding: binding });
});

test("corrupt sparse existing history or receipts fails closed before new schedule writes", async t => {
    const f = fixture(t);
    for (const [key, value] of [["history", { version: 1, items: Array(1) }],
        ["receipts", { version: 1, items: Array(1), last_at: 0 }]]) {
        f.values.clear();
        f.values.set(key, value);
        assert.equal((await f.save(fixed)).status, 503);
        assert.equal((await f.read()).error, "STATE_INVALID");
        assert.equal(f.values.has("schedule_settings"), false);
        assert.equal(f.values.has("plan"), false);
    }
});

test("public and internal schedule routes retain Basic auth and configuration gates before writes", async t => {
    const f = fixture(t);
    for (const path of ["/admin/schedule", "/admin/schedule/reset"]) {
        const body = path.endsWith("reset") ? { binding, revision: 0 } : { binding, revision: 0, schedule: fixed };
        assert.equal((await f.object().fetch(new Request("https://unit.test" + path + "?id=a", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))).status, 401);
    }
    assert.equal((await f.call("/a/schedule", { binding, revision: 0, schedule: fixed }, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal(f.values.size, 0);
    f.env.TRIGGER_CONFIG = "private_config_marker";
    assert.deepEqual(await (await f.save(fixed)).json(), { status: "CONFIG_INVALID" });
    assert.equal(f.values.size, 0);
    f.env.DEBUG_ACCESS_TOKEN = "";
    assert.equal((await f.save(fixed)).status, 404);
    assert.equal(f.http.mock.callCount(), 0);
});

for (const reason of ["manual", "unlinked", "identity", "deleted"]) {
    test(`missing guard stays unknown with ${reason} historical evidence`, async t => {
        const f = fixture(t);
        await f.read();
        const plan = f.values.get("plan");
        plan.slots[0] = { ...plan.slots[0], attempted: true, result: "DISPATCH_UNKNOWN", history_id: uuid };
        if (reason === "identity") plan.binding = JSON.stringify([JSON.stringify(["other/repo", "Checkin.yml", "main"]), fixed]);
        f.values.set("history", { version: 1, items: reason === "deleted" ? [] : [{
            id: reason === "unlinked" ? uuid.replace(/1$/, "2") : uuid,
            at: Date.now(), source: reason === "manual" ? "manual" : "automatic",
            result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" }] });
        assert.equal((await f.read()).automatic_state, "unknown");
        assert.equal(f.values.has("automatic_guard"), false);
    });
}

for (const key of ["schedule_settings", "automatic_guard"]) {
    test(`${key} corruption fails closed for reads, saves and alarm rather than falling back`, async t => {
        const f = fixture(t);
        await f.read();
        f.values.set(key, { version: 1, binding, private_field: "private_marker" });
        const state = await f.read();
        assert.equal(state.error, "STATE_INVALID");
        assert.equal(state.schedule_source, null);
        assert.equal(state.schedule_revision, null);
        const response = await f.save(fixed);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: "STATE_INVALID" });
        await assert.rejects(() => f.object().alarm(), /STATE_INVALID/);
        assert.equal(f.http.mock.callCount(), 0);
    });
}
