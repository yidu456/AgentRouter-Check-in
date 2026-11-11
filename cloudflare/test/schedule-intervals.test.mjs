import assert from "node:assert/strict";
import { test } from "node:test";
import * as config from "../src/config.mjs";
import { createPlan, migratePlan, planBinding, validPlan } from "../src/scheduling.mjs";

const { normalizeSchedule, parseConfig, scheduleFor, targetBinding } = config;
const target = schedule => ({ id: "a", repository: "owner/repo", workflow: "Checkin.yml", ref: "main",
    token_secret: "GITHUB_TOKEN_A", enabled: true, ...(schedule ? { schedule } : {}) });
const parsedTarget = schedule => parseConfig(JSON.stringify({ version: 1, targets: [target(schedule)] }))[0];
const random = (count, start, end, gap) => ({ mode: "random", count, window: { start, end },
    ...(gap === undefined ? {} : { min_interval_minutes: gap }) });
const midnight = Date.parse("2026-11-08T00:00:00+08:00");
const minutesOf = plan => plan.slots.map(slot => (slot.at - midnight) / 60000);

function diagnostic(schedule, field, code) {
    assert.throws(() => normalizeSchedule(schedule, "targets[2].schedule"), error => {
        assert.equal(error.message, "CONFIG_INVALID");
        assert.deepEqual(error.diagnostic, { field: `targets[2].schedule${field}`, code });
        return true;
    });
}

test("interval accepts integer endpoints and exports the shared omitted default", () => {
    assert.equal(typeof config.intervalMinutes, "function");
    assert.equal(config.intervalMinutes({ mode: "fixed", times: ["09:00"] }), 1);
    for (const gap of [1, 2, 60, 1440, 1441, 2880, 525600]) {
        for (const schedule of [{ mode: "fixed", times: ["09:00"], min_interval_minutes: gap },
            random(1, "09:00", "09:00", gap)]) {
            const normalized = normalizeSchedule(schedule);
            assert.equal(config.intervalMinutes(normalized), gap);
            assert.equal(Object.hasOwn(normalized, "min_interval_minutes"), gap !== 1);
        }
    }
});

test("explicit invalid interval values fail with the safe interval field diagnostic", () => {
    for (const gap of [undefined, null, true, false, "1", "private_interval_marker", 1.5, 0, -1, 525601, NaN, Infinity, {}, []]) {
        for (const schedule of [{ mode: "fixed", times: ["09:00"], min_interval_minutes: gap },
            { ...random(1, "09:00", "09:00"), min_interval_minutes: gap }]) {
            diagnostic(schedule, ".min_interval_minutes", "SCHEDULE_INTERVAL");
        }
    }
});

test("omitted and explicit one keep canonical schedules and existing bindings identical", () => {
    for (const schedule of [{ mode: "fixed", times: ["18:00", "09:00"] }, random(3, "09:00", "22:00")]) {
        const old = parsedTarget(schedule);
        const explicit = parsedTarget({ min_interval_minutes: 1, ...schedule });
        assert.deepEqual(explicit.schedule, old.schedule);
        assert.equal(planBinding(explicit), planBinding(old));
        assert.equal(Object.hasOwn(explicit.schedule, "min_interval_minutes"), false);
    }
    const explicitDefault = parsedTarget(random(1, "01:00", "23:00", 1));
    assert.deepEqual(scheduleFor(explicitDefault), scheduleFor(target()));
    assert.equal(planBinding(explicitDefault), planBinding(target()));
});

test("fixed schedules reject insufficient same-day and midnight cyclic spacing", () => {
    for (const times of [["09:59", "09:00"], ["23:45", "00:15"]]) {
        diagnostic({ mode: "fixed", times, min_interval_minutes: 60 }, ".times", "SCHEDULE_SPACING");
    }
    diagnostic({ mode: "fixed", times: ["00:00", "12:00"], min_interval_minutes: 721 },
        ".times", "SCHEDULE_SPACING");
});

test("fixed exact cyclic boundaries and a single daily 1440-minute slot are valid", () => {
    assert.deepEqual(normalizeSchedule({ mode: "fixed", times: ["23:30", "00:30"], min_interval_minutes: 60 }),
        { mode: "fixed", times: ["00:30", "23:30"], min_interval_minutes: 60 });
    const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
    assert.equal(normalizeSchedule({ mode: "fixed", times: hours, min_interval_minutes: 60 }).times.length, 24);
    assert.deepEqual(normalizeSchedule({ mode: "fixed", times: ["23:59"], min_interval_minutes: 1440 }),
        { mode: "fixed", times: ["23:59"], min_interval_minutes: 1440 });
});

test("random inclusive capacity accepts exact window spacing but rejects one minute less", () => {
    assert.deepEqual(normalizeSchedule(random(2, "09:00", "10:00", 60)), random(2, "09:00", "10:00", 60));
    assert.deepEqual(normalizeSchedule(random(1, "23:59", "23:59", 1440)), random(1, "23:59", "23:59", 1440));
    diagnostic(random(2, "09:00", "09:59", 60), ".count", "SCHEDULE_CAPACITY");
    diagnostic(random(3, "09:00", "10:00", 60), ".count", "SCHEDULE_CAPACITY");
    diagnostic(random(2, "09:00", "09:00"), ".count", "SCHEDULE_CAPACITY");
});

test("random daily density rejects impossible repeating counts even in a wide window", () => {
    diagnostic(random(2, "00:00", "23:59", 721), ".count", "SCHEDULE_CAPACITY");
    diagnostic(random(24, "00:00", "23:59", 61), ".count", "SCHEDULE_CAPACITY");
    assert.equal(normalizeSchedule(random(24, "00:00", "23:00", 60)).count, 24);
});

test("intervals above one day only allow one fixed or random slot", () => {
    for (const gap of [1441, 2880, 525600]) {
        diagnostic({ mode: "fixed", times: ["00:00", "23:59"], min_interval_minutes: gap },
            ".times", "SCHEDULE_SPACING");
        diagnostic(random(2, "00:00", "23:59", gap), ".count", "SCHEDULE_CAPACITY");
        for (const schedule of [{ mode: "fixed", times: ["09:00"], min_interval_minutes: gap },
            random(1, "09:00", "10:00", gap)]) {
            assert.deepEqual(parsedTarget(schedule).schedule, schedule);
        }
    }
});

test("optional interval keeps strict mode keys and existing validation diagnostics", () => {
    diagnostic({ mode: "fixed", times: ["09:00"], count: 1, min_interval_minutes: 60 }, "", "SCHEDULE_FIELDS");
    diagnostic({ ...random(1, "09:00", "10:00", 60), times: ["09:00"] }, "", "SCHEDULE_FIELDS");
    diagnostic({ ...random(1, "09:00", "10:00", 60), extra: true }, "", "SCHEDULE_FIELDS");
    diagnostic({ ...random(1, "09:00", "10:00", 60), window: { start: "09:00", end: "10:00", extra: true } },
        ".window", "SCHEDULE_FIELDS");
    diagnostic({ mode: "fixed", times: ["09:00", "09:00"], min_interval_minutes: 60 }, ".times", "SCHEDULE_DUPLICATE");
    diagnostic({ mode: "fixed", times: ["9:00"], min_interval_minutes: 60 }, ".times", "SCHEDULE_TIME");
    diagnostic(random(25, "09:00", "10:00", 60), ".count", "SCHEDULE_COUNT");
    diagnostic(random(1, "23:00", "01:00", 60), ".window", "SCHEDULE_TIME");
    diagnostic({ mode: "unknown", min_interval_minutes: 60 }, ".mode", "SCHEDULE_MODE");
});

test("one-minute compressed draws retain deterministic old unique sampling", t => {
    const draws = [4, 0, 1];
    let draw = 0;
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = draws[draw++]; return bytes; });
    for (const gap of [undefined, 1]) {
        draw = 0;
        const plan = createPlan(parsedTarget(random(3, "09:00", "09:06", gap)), null, midnight);
        assert.deepEqual(minutesOf(plan), [540, 542, 544]);
        assert.equal(draw, 3);
        assert.equal(validPlan(plan), true);
    }
});

test("compressed multi-draw sampling restores the gap while retaining both window endpoints", t => {
    const draws = [4, 0, 1];
    let draw = 0;
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = draws[draw++]; return bytes; });
    const plan = createPlan(target(random(3, "09:00", "09:06", 2)), null, midnight);
    assert.deepEqual(minutesOf(plan), [540, 543, 546]);
    assert.equal(draw, 3);
    assert.equal(validPlan(plan), true);
});

test("tight 24-slot capacity returns every slot without a retry or reduced count", t => {
    let draws = 0;
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = draws++; return bytes; });
    const plan = createPlan(target(random(24, "00:00", "23:00", 60)), null, midnight - 1);
    assert.deepEqual(minutesOf(plan), Array.from({ length: 24 }, (_, hour) => hour * 60));
    assert.equal(draws, 24);
    assert.equal(validPlan(plan), true);
});

test("varied random draws always produce exactly 24 sorted in-window slots with the requested gap", t => {
    let seed = 0, draws = 0;
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = seed * 31 + draws++ * 17; return bytes; });
    for (seed = 0; seed < 64; seed++) {
        draws = 0;
        const plan = createPlan(target(random(24, "00:00", "23:59", 59)), null, midnight - 1);
        const minutes = minutesOf(plan);
        assert.equal(minutes.length, 24);
        assert.ok(minutes.every((minute, index) => minute >= 0 && minute <= 1439
            && (index === 0 || minute - minutes[index - 1] >= 59)));
        assert.equal(draws, 24);
        assert.equal(validPlan(plan), true);
    }
});

test("single random slot supports a zero-span endpoint and full-day interval", t => {
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = 0; return bytes; });
    const plan = createPlan(parsedTarget(random(1, "23:59", "23:59", 1440)), null, midnight);
    assert.deepEqual(minutesOf(plan), [1439]);
    assert.equal(plan.slots[0].result, "PLANNED");
    assert.equal(validPlan(plan), true);
});

test("long-gap fixed plans use the first daily slot at or after the future horizon", () => {
    const item = target({ mode: "fixed", times: ["09:00"], min_interval_minutes: 2880 });
    for (const [earliest, want] of [
        ["2026-11-10T00:00:00+08:00", "2026-11-10T09:00:00+08:00"],
        ["2026-11-10T09:00:00+08:00", "2026-11-10T09:00:00+08:00"],
        ["2026-11-10T09:00:00.001+08:00", "2026-11-11T09:00:00+08:00"],
        ["2027-11-08T09:00:00+08:00", "2027-11-08T09:00:00+08:00"],
    ]) {
        const plan = createPlan(item, null, midnight, false, Date.parse(earliest));
        assert.deepEqual(plan.slots, [{ at: Date.parse(want), attempted: false, result: "PLANNED" }]);
        assert.equal(validPlan(plan), true);
    }
});

test("long-gap random plans clip future-day windows to the earliest allowed minute", t => {
    const item = target(random(1, "09:00", "10:00", 2880));
    for (const [earliest, first, last] of [
        ["2026-11-10T00:00:00+08:00", "2026-11-10T09:00:00+08:00", "2026-11-10T10:00:00+08:00"],
        ["2026-11-10T09:00:00+08:00", "2026-11-10T09:00:00+08:00", "2026-11-10T10:00:00+08:00"],
        ["2026-11-10T09:30:00.001+08:00", "2026-11-10T09:31:00+08:00", "2026-11-10T10:00:00+08:00"],
        ["2026-11-10T10:00:00+08:00", "2026-11-10T10:00:00+08:00", "2026-11-10T10:00:00+08:00"],
        ["2026-11-10T10:00:00.001+08:00", "2026-11-11T09:00:00+08:00", "2026-11-11T10:00:00+08:00"],
    ]) {
        for (const [draw, want] of [[0, first], [(Date.parse(last) - Date.parse(first)) / 60000, last]]) {
            t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = draw; return bytes; });
            const plan = createPlan(item, null, midnight, false, Date.parse(earliest));
            assert.deepEqual(plan.slots, [{ at: Date.parse(want), attempted: false, result: "PLANNED" }]);
            assert.equal(validPlan(plan), true);
            t.mock.restoreAll();
        }
    }
});

test("future long-gap random horizon at local midnight includes that exact daily slot", t => {
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = 0; return bytes; });
    const plan = createPlan(target(random(1, "00:00", "00:00", 525600)), null, midnight, false,
        Date.parse("2027-11-08T00:00:00+08:00"));
    assert.equal(plan.date, "2027-11-08");
    assert.deepEqual(plan.slots, [{ at: Date.parse("2027-11-08T00:00:00+08:00"), attempted: false, result: "PLANNED" }]);
    assert.equal(validPlan(plan), true);
});

test("future horizon retains afterPrevious date ordering and the last result", t => {
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = 0; return bytes; });
    const previous = { date: "2026-11-10", slots: [{ at: Date.parse("2026-11-10T09:00:00+08:00"),
        attempted: true, result: "DISPATCH_UNKNOWN", notification: "NOTIFY_ACCEPTED" }] };
    for (const schedule of [{ mode: "fixed", times: ["09:00"], min_interval_minutes: 2880 },
        random(1, "09:00", "10:00", 2880)]) {
        const plan = createPlan(target(schedule), previous, midnight, true, Date.parse("2026-11-10T09:00:00+08:00"));
        assert.equal(plan.date, "2026-11-11");
        assert.equal(plan.slots[0].at, Date.parse("2026-11-11T09:00:00+08:00"));
        assert.deepEqual(plan.last, { date: "2026-11-10", at: previous.slots[0].at,
            result: "DISPATCH_UNKNOWN", notification: "NOTIFY_ACCEPTED" });
        assert.equal(validPlan(plan), true);
    }
});

test("default and elapsed horizons preserve fixed missed flags and the next full random window", t => {
    t.mock.method(crypto, "getRandomValues", bytes => { bytes[0] = 0; return bytes; });
    const now = Date.parse("2026-11-08T09:00:00+08:00");
    for (const earliest of [undefined, now, midnight]) {
        const fixed = createPlan(target({ mode: "fixed", times: ["09:00", "18:00"] }), null, now, false, earliest);
        assert.equal(fixed.date, "2026-11-08");
        assert.deepEqual(fixed.slots, [
            { at: now, attempted: true, result: "MISSED_DATE" },
            { at: Date.parse("2026-11-08T18:00:00+08:00"), attempted: false, result: "PLANNED" },
        ]);
        for (const gap of [1, 2880]) {
            const plan = createPlan(target(random(1, "09:00", "10:00", gap)), null, now, false, earliest);
            assert.equal(plan.date, "2026-11-09");
            assert.equal(plan.slots[0].at, Date.parse("2026-11-09T09:00:00+08:00"));
        }
    }
});

test("explicit default interval migrates v1 bindings without redraw or lost attempted state", () => {
    const old = { version: 1, id: "a", binding: targetBinding(target()), date: "2026-11-08",
        at: Date.parse("2026-11-08T15:37:00+08:00"), attempted: true, result: "DISPATCH_UNKNOWN",
        history_id: "00000000-0000-4000-8000-000000000001", notification: "NOTIFY_UNKNOWN" };
    const migrated = migratePlan(old, parsedTarget(random(1, "01:00", "23:00", 1)));
    assert.equal(migrated.binding, planBinding(target()));
    assert.deepEqual(migrated.slots, [{ at: old.at, attempted: true, result: "DISPATCH_UNKNOWN",
        history_id: old.history_id, notification: "NOTIFY_UNKNOWN" }]);
    assert.equal(validPlan(migrated), true);
    assert.equal(migratePlan(migrated, target()), migrated);
});

test("plan result whitelist accepts attempted INTERVAL_SKIPPED without accepting arbitrary markers", () => {
    const slot = { at: Date.parse("2026-11-08T09:00:00+08:00"), attempted: true, result: "INTERVAL_SKIPPED" };
    const plan = { version: 2, id: "a", binding: planBinding(target()), date: "2026-11-08", slots: [slot],
        last: { date: "2026-11-07", at: Date.parse("2026-11-07T09:00:00+08:00"), result: "INTERVAL_SKIPPED" } };
    assert.equal(validPlan(plan), true);
    const legacy = { version: 1, id: "a", binding: targetBinding(target()), date: plan.date, ...slot };
    assert.equal(validPlan(legacy), true);
    assert.equal(validPlan(migratePlan(legacy, target())), true);
    assert.equal(validPlan({ ...plan, slots: [{ ...slot, attempted: false }] }), false);
    for (const result of ["INTERVAL_SKIPPED\n", "INTERVAL_SKIPPED_PRIVATE", "private_marker"]) {
        assert.equal(validPlan({ ...plan, slots: [{ ...slot, result }] }), false);
        assert.equal(validPlan({ ...plan, last: { ...plan.last, result } }), false);
    }
    assert.equal(validPlan({ ...plan, min_interval_minutes: 60 }), false);
});
