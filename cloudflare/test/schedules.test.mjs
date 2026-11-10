import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig, targetBinding, inspectConfig } from "../src/config.mjs";
import { validPlan, migratePlan, planBinding } from "../src/scheduling.mjs";
import { timingSafeEqual } from "node:crypto";
import { TriggerSchedule } from "../src/worker.mjs";

const target = (schedule) => ({ id: "a", repository: "owner/repo", workflow: "Checkin.yml", ref: "main",
    token_secret: "GITHUB_TOKEN_A", enabled: true, ...(schedule ? { schedule } : {}) });
const raw = (schedule) => JSON.stringify({ version: 1, targets: [target(schedule)] });
const fixed = { mode: "fixed", times: ["09:00", "12:00", "18:00"] };
const init = () => new Request("https://unit.test/init?id=a", { method: "POST" });
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const admin = (action, body) => new Request(`https://unit.test/admin/${action}?id=a`, {
    method: "POST", headers: { Authorization: "Basic " + Buffer.from("admin:dummy-long-secret-for-tests").toString("base64"),
        "Content-Type": "application/json" }, body: JSON.stringify(body) });
const read = () => new Request("https://unit.test/admin/state?id=a", { headers: {
    Authorization: "Basic " + Buffer.from("admin:dummy-long-secret-for-tests").toString("base64") } });
function fixture(t, schedule = fixed, nowText = "2026-11-08T00:05:00+08:00") {
    let now = Date.parse(nowText), alarm = null;
    const values = new Map();
    const storage = { async get(k) { return structuredClone(values.get(k)); },
        async put(k, v) {
            const batch = structuredClone(typeof k === "string" ? { [k]: v } : k);
            for (const [name, saved] of Object.entries(batch)) values.set(name, saved);
        }, async getAlarm() { return alarm; },
        async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; } };
    let queue = Promise.resolve();
    const ctx = { storage, blockConcurrencyWhile(fn) { const p = queue.then(fn); queue = p.catch(() => {}); return p; } };
    const env = { TRIGGER_CONFIG: raw(schedule), GITHUB_TOKEN_A: "github_pat_dummy_tests",
        DEBUG_ACCESS_TOKEN: "dummy_access_" + "x".repeat(40), ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "dummy-long-secret-for-tests" };
    t.mock.method(Date, "now", () => now);
    t.mock.method(console, "log", () => {});
    const http = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    return { object: new TriggerSchedule(ctx, env), values, storage, env, ctx, http,
        plan: () => values.get("plan"), alarm: () => alarm, setNow: (text) => { now = Date.parse(text); } };
}

test("fixed times canonicalize and random count validates bounded same-day window", () => {
    assert.deepEqual(parseConfig(raw({ mode: "fixed", times: ["18:00", "09:00"] }))[0].schedule,
        { mode: "fixed", times: ["09:00", "18:00"] });
    assert.equal(parseConfig(raw({ mode: "random", count: 3, window: { start: "09:00", end: "22:00" } }))[0].schedule.count, 3);
    const bad = [{ mode: "fixed", times: [] }, { mode: "fixed", times: ["09:00", "09:00"] },
        { mode: "fixed", times: ["9:00"] }, { mode: "fixed", times: ["24:00"] },
        ...[0, 25, true, "2"].map(count => ({ mode: "random", count, window: { start: "09:00", end: "22:00" } })),
        { mode: "random", count: 2, window: { start: "22:00", end: "09:00" } },
        { mode: "random", count: 2, window: { start: "09:00", end: "09:00" } },
        { mode: "fixed", times: ["09:00"], count: 1 }];
    for (const schedule of bad) assert.throws(() => parseConfig(raw(schedule)), /CONFIG_INVALID/);
});

test("three fixed slots dispatch independently with durable attempted markers and next alarm", async (t) => {
    const f = fixture(t);
    await f.object.fetch(init());
    assert.equal(f.plan().version, 2);
    assert.equal(f.plan().slots.length, 3);
    assert.equal(f.alarm(), Date.parse("2026-11-08T09:00:00+08:00"));
    f.http.mock.mockImplementation(async () => {
        const attempted = f.plan().slots.filter(s => s.attempted);
        assert.ok(attempted.length);
        assert.equal(attempted.at(-1).result, "DISPATCH_UNKNOWN");
        return new Response(null, { status: 204 });
    });
    for (const [i, time] of ["09:00", "12:00", "18:00"].entries()) {
        f.setNow(`2026-11-08T${time}:00+08:00`);
        await f.object.alarm();
        assert.equal(f.http.mock.callCount(), i + 1);
        await f.object.alarm();
        assert.equal(f.http.mock.callCount(), i + 1);
    }
    assert.equal(f.plan().date, "2026-11-09");
    assert.equal(f.values.get("history").items.length, 3);
});

test("random multislots are unique sorted bounded and remain unchanged on restart", async (t) => {
    const f = fixture(t, { mode: "random", count: 24, window: { start: "09:00", end: "22:00" } });
    let sample = 0;
    t.mock.method(crypto, "getRandomValues", a => { a[0] = sample++; return a; });
    await f.object.fetch(init());
    const p = structuredClone(f.plan());
    assert.equal(new Set(p.slots.map(s => s.at)).size, 24);
    assert.deepEqual(p.slots.map(s => s.at), p.slots.map(s => s.at).sort((a, b) => a - b));
    assert.ok(p.slots.every(s => s.at >= Date.parse("2026-11-08T09:00:00+08:00")
        && s.at <= Date.parse("2026-11-08T22:00:00+08:00")));
    await new TriggerSchedule(f.ctx, f.env).fetch(init());
    assert.deepEqual(f.plan(), p);
    assert.equal(f.http.mock.callCount(), 0);
});

test("late alarm skips older overdue slots instead of bursting three dispatches", async (t) => {
    const f = fixture(t);
    await f.object.fetch(init());
    f.setNow("2026-11-08T13:00:00+08:00");
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal(f.plan().slots[0].result, "MISSED_DATE");
    assert.equal(f.plan().slots[1].result, "DISPATCH_ACCEPTED");
    assert.equal(f.alarm(), Date.parse("2026-11-08T18:00:00+08:00"));
});

test("initial fixed afternoon uses only future times and explicit random starts next full window", async (t) => {
    const f = fixture(t, fixed, "2026-11-08T13:00:00+08:00");
    await f.object.fetch(init());
    assert.equal(f.plan().date, "2026-11-08");
    assert.equal(f.alarm(), Date.parse("2026-11-08T18:00:00+08:00"));
    assert.equal(f.plan().slots[0].result, "MISSED_DATE");
    f.env.TRIGGER_CONFIG = raw({ mode: "random", count: 3, window: { start: "09:00", end: "22:00" } });
    await f.object.fetch(init());
    assert.equal(f.plan().date, "2026-11-09");
    assert.equal(f.http.mock.callCount(), 0);
});

test("v1 single random plan migrates without redraw or lost attempted state", async (t) => {
    const f = fixture(t, null);
    const at = Date.parse("2026-11-08T15:37:00+08:00");
    f.values.set("plan", { version: 1, id: "a", binding: targetBinding(target()), date: "2026-11-08",
        at, attempted: false, result: "PLANNED" });
    await f.object.fetch(init());
    assert.equal(f.plan().version, 2);
    assert.equal(f.plan().slots[0].at, at);
    assert.equal(f.alarm(), at);
    assert.equal(f.http.mock.callCount(), 0);
});

test("failed post-HTTP save retains UNKNOWN and restarted callback cannot duplicate", async (t) => {
    const f = fixture(t);
    await f.object.fetch(init());
    f.setNow("2026-11-08T09:00:00+08:00");
    const put = f.storage.put;
    f.storage.put = async (k, v) => {
        const plan = typeof k === "object" ? k.plan : k === "plan" ? v : null;
        if (plan?.slots[0].result === "DISPATCH_ACCEPTED") throw new Error("private_storage");
        return put(k, v);
    };
    await assert.rejects(() => f.object.alarm());
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal(f.plan().slots[0].result, "DISPATCH_UNKNOWN");
    f.storage.put = put;
    await new TriggerSchedule(f.ctx, f.env).alarm();
    assert.equal(f.http.mock.callCount(), 1);
});

test("reopening multiple fixed slots skips paused times and schedule changes preserve the disabled control", async t => {
    const f = fixture(t);
    await f.object.fetch(init());
    await f.object.fetch(admin("enabled", { enabled: false }));
    f.setNow("2026-11-08T13:00:00+08:00");
    await f.object.fetch(admin("enabled", { enabled: true }));
    assert.deepEqual(f.plan().slots.map(s => s.result), ["MISSED_DATE", "MISSED_DATE", "PLANNED"]);
    assert.equal(f.alarm(), Date.parse("2026-11-08T18:00:00+08:00"));
    await f.object.fetch(admin("enabled", { enabled: false }));
    f.env.TRIGGER_CONFIG = raw({ mode: "fixed", times: ["14:00", "20:00"] });
    await f.object.fetch(init());
    assert.equal(f.values.get("control").enabled, false);
    assert.equal(f.alarm(), null);
    await f.object.fetch(admin("enabled", { enabled: true }));
    assert.equal(f.plan().binding, planBinding(parseConfig(f.env.TRIGGER_CONFIG)[0]));
    assert.equal(f.alarm(), Date.parse("2026-11-08T14:00:00+08:00"));
    assert.equal(f.http.mock.callCount(), 0);
});

test("cross-date backlog is skipped and manual dispatch never consumes automatic slots", async t => {
    const f = fixture(t);
    await f.object.fetch(init());
    const before = structuredClone(f.plan());
    await f.object.fetch(admin("run", { request_id: "00000000-0000-4000-8000-000000000001" }));
    assert.deepEqual(f.plan(), before);
    assert.equal(f.http.mock.callCount(), 1);
    f.setNow("2026-11-09T13:00:00+08:00");
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal(f.plan().date, "2026-11-09");
    assert.equal(f.plan().last.result, "MISSED_DATE");
    assert.equal(f.alarm(), Date.parse("2026-11-09T18:00:00+08:00"));
});

test("v1 migration retains an already-attempted UNKNOWN slot and its history linkage", () => {
    const old = { version: 1, id: "a", binding: targetBinding(target()), date: "2026-11-08",
        at: Date.parse("2026-11-08T15:37:00+08:00"), attempted: true, result: "DISPATCH_UNKNOWN",
        history_id: "00000000-0000-4000-8000-000000000001", notification: "NOTIFY_UNKNOWN" };
    const next = migratePlan(old, target());
    assert.deepEqual(next.slots, [{ at: old.at, attempted: true, result: old.result,
        history_id: old.history_id, notification: old.notification }]);
    assert.equal(next.binding, planBinding(target()));
    assert.equal(validPlan(next), true);
});

test("malformed v2 slots including sparse storage fail closed before dispatch", async t => {
    const f = fixture(t);
    await f.object.fetch(init());
    const good = structuredClone(f.plan());
    const bad = [[], Array(3), [good.slots[1], good.slots[0]], [good.slots[0], good.slots[0]],
        [{ ...good.slots[0], result: "private_marker" }], [{ ...good.slots[0], at: good.slots[0].at + 1 }]];
    for (const slots of bad) {
        const plan = { ...good, slots };
        assert.equal(validPlan(plan), false);
        f.values.set("plan", plan);
        await assert.rejects(() => f.object.alarm(), /STATE_INVALID/);
    }
    assert.equal(f.http.mock.callCount(), 0);
});

test("non-object target inspection never invents a valid default schedule", () => {
    for (const source of [null, 7, "private_marker", []]) {
        const result = inspectConfig(JSON.stringify({ version: 1, targets: [source] }));
        assert.equal(result.items[0].schedule, null);
        assert.equal(result.items[0].id, null);
        assert.equal(result.state, "invalid");
    }
});

test("equivalent random window key order never redraws or changes legacy migration binding", async t => {
    const f = fixture(t, { mode: "random", count: 3, window: { start: "09:00", end: "22:00" } });
    await f.object.fetch(init());
    const before = structuredClone(f.plan());
    f.env.TRIGGER_CONFIG = raw({ mode: "random", count: 3, window: { end: "22:00", start: "09:00" } });
    await f.object.fetch(read());
    assert.deepEqual(f.plan(), before);
    assert.equal(f.http.mock.callCount(), 0);
    const legacy = { version: 1, id: "a", binding: targetBinding(target()), date: "2026-11-08",
        at: Date.parse("2026-11-08T15:37:00+08:00"), attempted: false, result: "PLANNED" };
    const equivalent = parseConfig(raw({ mode: "random", count: 1, window: { end: "23:00", start: "01:00" } }))[0];
    assert.equal(migratePlan(legacy, equivalent).binding, planBinding(equivalent));
});

test("read restores the earliest future Alarm despite earlier overdue slots without dispatch or redraw", async t => {
    const f = fixture(t);
    await f.object.fetch(init());
    const before = structuredClone(f.plan());
    await f.storage.deleteAlarm();
    f.setNow("2026-11-08T13:00:00+08:00");
    const response = await f.object.fetch(read());
    assert.equal((await response.json()).next_run, "2026-11-08T10:00:00.000Z");
    assert.equal(f.alarm(), Date.parse("2026-11-08T18:00:00+08:00"));
    assert.deepEqual(f.plan(), before);
    assert.equal(f.http.mock.callCount(), 0);
});

for (const action of ["init", "alarm"]) {
    test(`removing explicit schedule uses first default date without skipping tomorrow through ${action}`, async t => {
        const f = fixture(t, { mode: "random", count: 3, window: { start: "09:00", end: "22:00" } },
            "2026-11-08T13:00:00+08:00");
        await f.object.fetch(init());
        assert.equal(f.plan().date, "2026-11-09");
        f.env.TRIGGER_CONFIG = raw(null);
        if (action === "init") await f.object.fetch(init());
        else await f.object.alarm();
        assert.equal(f.plan().date, "2026-11-09");
        assert.equal(f.http.mock.callCount(), 0);
    });
}

test("canonical random bindings and legacy-equivalent migration ignore window key order", () => {
    const first = parseConfig(raw({ mode: "random", count: 1, window: { start: "01:00", end: "23:00" } }))[0];
    const reordered = parseConfig(raw({ mode: "random", count: 1, window: { end: "23:00", start: "01:00" } }))[0];
    assert.equal(planBinding(reordered), planBinding(first));
    const legacy = { version: 1, id: "a", binding: targetBinding(target()), date: "2026-11-08",
        at: Date.parse("2026-11-08T15:37:00+08:00"), attempted: false, result: "PLANNED" };
    assert.equal(migratePlan(legacy, reordered).binding, planBinding(first));
    assert.deepEqual(migratePlan(legacy, reordered).slots, [{ at: legacy.at, attempted: false, result: "PLANNED" }]);
});
