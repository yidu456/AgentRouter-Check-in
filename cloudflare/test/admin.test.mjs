import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import worker, { TriggerSchedule } from "../src/worker.mjs";
import { adminState, authorized } from "../src/admin.mjs";

// Workers adds this extension; hashing and all other Web Crypto remain native.
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const access = "dummy_access_token_for_unit_tests_123456";
const target = (overrides = {}) => ({ id: "github_a", repository: "owner/repo", workflow: "Checkin.yml",
    ref: "main", token_secret: "GITHUB_TOKEN_A", enabled: true, ...overrides });
const config = (targets) => JSON.stringify({ version: 1, targets });
const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture(t, options = {}) {
    let now = Date.parse(options.now ?? "2026-11-07T00:05:00+08:00");
    let alarm = null;
    const values = new Map();
    const storage = {
        async get(key) { return structuredClone(values.get(key)); },
        async put(key, value) {
            const batch = structuredClone(typeof key === "string" ? { [key]: value } : key);
            for (const [name, saved] of Object.entries(batch)) values.set(name, saved);
        },
        async delete(key) { return values.delete(key); },
        async getAlarm() { return alarm; },
        async setAlarm(at) { alarm = at; },
        async deleteAlarm() { alarm = null; },
    };
    let queue = Promise.resolve();
    const ctx = { storage, blockConcurrencyWhile(fn) {
        const pending = queue.then(fn);
        queue = pending.catch(() => {});
        return pending;
    } };
    const env = { TRIGGER_CONFIG: config(options.targets ?? [target()]),
        DEBUG_ACCESS_TOKEN: access, ADMIN_USERNAME: "test-admin", ADMIN_PASSWORD: "dummy-long-secret-for-tests", GITHUB_TOKEN_A: "github_pat_dummy_tests" };
    const object = new TriggerSchedule(ctx, env);
    const namespaceCalls = [];
    env.SCHEDULES = {
        idFromName(id) { namespaceCalls.push(id); return id; },
        get() { return object; },
    };
    t.mock.method(Date, "now", () => now);
    t.mock.method(crypto, "getRandomValues", (array) => { array[0] = 60; return array; });
    t.mock.method(console, "log", () => {});
    const http = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    const call = (path = "", body, headers = {}) => worker.fetch(new Request(
        `https://unit.test/api/admin/targets${path}`, { method: body === undefined ? "GET" : "POST",
            headers: { Authorization: "Basic " + Buffer.from("test-admin:dummy-long-secret-for-tests").toString("base64"), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
            ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), env);
    return { env, object, ctx, storage, values, http, namespaceCalls, call, alarm: () => alarm,
        setNow(value) { now = typeof value === "number" ? value : Date.parse(value); },
        advance(ms) { now += ms; },
        init() { return object.fetch(new Request("https://scheduler.internal/init?id=github_a", { method: "POST" })); } };
}

test("admin authenticates before namespace access and rejects query-string credentials", async (t) => {
    const f = fixture(t);
    for (const request of [new Request("https://unit.test/api/admin/targets"),
        new Request(`https://unit.test/api/admin/targets?token=${access}`),
        new Request("https://unit.test/api/admin/targets", { headers: { Authorization: "Bearer wrong" } })]) {
        assert.equal((await worker.fetch(request, f.env)).status, 401);
    }
    assert.deepEqual(f.namespaceCalls, []);
    assert.equal(f.http.mock.callCount(), 0);
});

test("missing empty or invalid access Secret closes feature without namespace effects", async (t) => {
    const f = fixture(t);
    for (const value of [undefined, "", null, 7, "x".repeat(31), "x".repeat(129), `${access}\n`, "x".repeat(31) + "+"]) {
        f.env.DEBUG_ACCESS_TOKEN = value;
        assert.equal((await f.call()).status, 404);
    }
    assert.deepEqual(f.namespaceCalls, []);
    assert.equal(f.http.mock.callCount(), 0);
});

test("mutation rejects wrong Origin media type size shape and verb before DO effects", async (t) => {
    const f = fixture(t);
    const cases = [
        ["/github_a/enabled", { enabled: false }, { Origin: "https://evil.test" }, 403],
        ["/github_a/enabled", { enabled: false }, { "Content-Type": "text/plain" }, 415],
        ["/github_a/enabled", "x".repeat(1025), {}, 413],
        ["/github_a/enabled", "{broken", {}, 400],
        ["/github_a/enabled", { enabled: "false" }, {}, 400],
        ["/github_a/enabled", { enabled: true, extra: access }, {}, 400],
        ["/github_a/run", { request_id: "invalid" }, {}, 400],
        ["/github_a/logs/delete", { log_id: "invalid" }, {}, 400],
        ["/github_a/logs/clear", { extra: true }, {}, 400],
        ["/github_a/run", undefined, {}, 404],
    ];
    for (const [path, body, headers, expected] of cases)
        assert.equal((await f.call(path, body, headers)).status, expected);
    assert.deepEqual(f.namespaceCalls, []);
    assert.equal(f.http.mock.callCount(), 0);
});

test("authenticated first read schedules enabled target without dispatch or repeated randomization", async (t) => {
    const f = fixture(t);
    const response = await f.call();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Cache-Control"), /no-store/);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.deepEqual(await response.json(), { status: "OK", targets: [{ id: "github_a", repository: "owner/repo",
        workflow: "Checkin.yml", ref: "main", enabled: true, token_state: "configured",
        next_run: "2026-11-06T18:00:00.000Z", history: [], error: null,
        schedule: { mode: "random", count: 1, window: { start: "01:00", end: "23:00" } },
        schedule_source: "variable", schedule_revision: 0,
        target_binding: '["github_a","[\\"owner/repo\\",\\"Checkin.yml\\",\\"main\\"]"]',
        automatic_state: "unknown", automatic_last_at: null, automatic_next_allowed_at: null,
        schedule_date: "2026-11-07", slots: [{ at: "2026-11-06T18:00:00.000Z", attempted: false, result: "PLANNED" }] }] });
    const plan = structuredClone(f.values.get("plan"));
    assert.equal(f.alarm(), plan.slots[0].at);
    await f.call();
    assert.deepEqual(f.values.get("plan"), plan);
    assert.equal(f.http.mock.callCount(), 0);
});

test("first read does not schedule disabled or missing-token targets", async (t) => {
    const f = fixture(t);
    for (const overrides of [{ enabled: false }, { token_secret: "GITHUB_TOKEN_MISSING" }]) {
        f.env.TRIGGER_CONFIG = config([target(overrides)]);
        const state = (await (await f.call()).json()).targets[0];
        assert.equal(state.next_run, null);
        assert.equal(f.values.size, 0);
        assert.equal(f.alarm(), null);
    }
    assert.equal(f.http.mock.callCount(), 0);
});

test("initial alarm storage failure can recover without redraw or dispatch", async (t) => {
    const f = fixture(t);
    const setAlarm = f.storage.setAlarm;
    f.storage.setAlarm = async () => { throw new Error("private_alarm_error"); };
    const failed = (await (await f.call()).json()).targets[0];
    assert.equal(failed.error, "STORAGE_UNAVAILABLE");
    const plan = structuredClone(f.values.get("plan"));
    f.storage.setAlarm = setAlarm;
    const recovered = (await (await f.call()).json()).targets[0];
    assert.equal(recovered.next_run, "2026-11-06T18:00:00.000Z");
    assert.deepEqual(f.values.get("plan"), plan);
    assert.equal(f.alarm(), plan.slots[0].at);
    assert.equal(f.http.mock.callCount(), 0);
});

test("internal admin routes also fail closed before storage effects", async (t) => {
    const f = fixture(t);
    const response = await f.object.fetch(new Request("https://scheduler.internal/admin/state?id=github_a"));
    assert.equal(response.status, 401);
    assert.equal(f.values.size, 0);
    assert.equal(f.alarm(), null);
});

test("missing target and storage use safe errors without exception text", async (t) => {
    const f = fixture(t);
    assert.equal((await f.call("/missing/run", { request_id: uuid() })).status, 404);
    f.env.SCHEDULES.get = () => { throw new Error(`private ${access}`); };
    const response = await f.call("/github_a/run", { request_id: uuid() });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "STORAGE_UNAVAILABLE" });
});

test("entry state and Basic authorization use exact credentials and fixed SHA-256 comparison", async (t) => {
    assert.equal(adminState({}), "disabled");
    assert.equal(adminState({ DEBUG_ACCESS_TOKEN: "private" }), "invalid");
    assert.equal(adminState({ DEBUG_ACCESS_TOKEN: access }), "configured");
    const sizes = [];
    t.mock.method(crypto.subtle, "timingSafeEqual", (a, b) => {
        sizes.push([a.byteLength, b.byteLength]);
        return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    });
    const env = { DEBUG_ACCESS_TOKEN: access, ADMIN_USERNAME: "test-admin", ADMIN_PASSWORD: "dummy-long-secret-for-tests" };
    for (const [value, want] of [["test-admin:dummy-long-secret-for-tests", true], ["other:dummy-long-secret-for-tests", false]]) {
        assert.equal(await authorized(new Request("https://unit.test/", { headers: {
            Authorization: "Basic " + Buffer.from(value).toString("base64") } }), env), want);
    }
    assert.equal(await authorized(new Request("https://unit.test/", { headers: { Authorization: `Bearer ${access}` } }), env), false);
    assert.deepEqual(sizes, [[32, 32], [32, 32]]);
});

test("persisted disable removes alarm, blocks both dispatch sources and survives restart and cron", async (t) => {
    const f = fixture(t);
    await f.init();
    const plan = structuredClone(f.values.get("plan"));
    assert.equal((await f.call("/github_a/enabled", { enabled: false }, { Origin: "https://unit.test" })).status, 200);
    assert.equal(f.alarm(), null);
    assert.deepEqual(f.values.get("plan"), plan);
    assert.equal((await f.call()).status, 200);
    assert.equal((await (await f.call()).json()).targets[0].enabled, false);
    f.setNow("2026-11-07T02:00:00+08:00");
    await new TriggerSchedule(f.ctx, f.env).alarm();
    await worker.scheduled({}, f.env);
    assert.equal(f.alarm(), null);
    assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 409);
    assert.equal(f.http.mock.callCount(), 0);
});

test("database enable overrides JSON false and cron visits configured disabled targets", async (t) => {
    const f = fixture(t, { targets: [target({ enabled: false })] });
    assert.equal((await f.call("/github_a/enabled", { enabled: true })).status, 200);
    const plan = structuredClone(f.values.get("plan"));
    assert.equal(plan.slots[0].attempted, false);
    await f.storage.deleteAlarm();
    await worker.scheduled({}, f.env);
    assert.equal(f.alarm(), plan.slots[0].at);
    assert.deepEqual(f.values.get("plan"), plan);
    assert.deepEqual(f.namespaceCalls.slice(-1), ["v1:github_a"]);
});

test("reopen retains only a future unattempted matching plan and skips elapsed same-date plan", async (t) => {
    const f = fixture(t);
    await f.init();
    const before = structuredClone(f.values.get("plan"));
    await f.call("/github_a/enabled", { enabled: false });
    await f.call("/github_a/enabled", { enabled: true });
    assert.deepEqual(f.values.get("plan"), before);
    assert.equal(f.alarm(), before.slots[0].at);
    await f.call("/github_a/enabled", { enabled: false });
    f.setNow("2026-11-07T02:05:00+08:00");
    await f.call("/github_a/enabled", { enabled: true });
    assert.equal(f.values.get("plan").date, "2026-11-08");
    assert.equal(f.values.get("plan").last.result, "MISSED_DATE");
    assert.equal(f.http.mock.callCount(), 0);
});

test("retried already-enabled setter preserves overdue same-date plan for ordinary delayed alarm", async (t) => {
    const f = fixture(t);
    await f.init();
    await f.call("/github_a/enabled", { enabled: false });
    assert.equal((await f.call("/github_a/enabled", { enabled: true })).status, 200);
    const before = structuredClone(f.values.get("plan"));
    f.setNow("2026-11-07T02:05:00+08:00");
    for (let retry = 0; retry < 2; retry++) {
        assert.equal((await f.call("/github_a/enabled", { enabled: true })).status, 200);
        assert.deepEqual(f.values.get("plan"), before);
        assert.ok(f.alarm() >= Date.now());
    }
    assert.equal(f.http.mock.callCount(), 0);
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal(f.values.get("plan").last.result, "DISPATCH_ACCEPTED");
});

for (const stage of ["read", "skip", "replan"]) {
    test(`failed reopen ${stage} preparation keeps disabled and retry cannot catch up elapsed plan`, async (t) => {
        const f = fixture(t);
        await f.init();
        await f.call("/github_a/enabled", { enabled: false });
        f.setNow("2026-11-07T02:05:00+08:00");
        const get = f.storage.get;
        const put = f.storage.put;
        let planReads = 0;
        f.storage.get = async (key) => {
            if (key === "plan" && ++planReads === 2 && stage === "read") throw new Error("fixture_read_failure");
            return get(key);
        };
        f.storage.put = async (key, value) => {
            if (key === "plan" && (stage === "skip" && value.slots[0].result === "MISSED_DATE"
                    || stage === "replan" && value.date === "2026-11-08")) throw new Error("fixture_write_failure");
            return put(key, value);
        };
        assert.equal((await f.call("/github_a/enabled", { enabled: true })).status, 503);
        assert.equal(f.values.get("control").enabled, false);
        assert.equal(f.alarm(), null);
        f.storage.get = get;
        f.storage.put = put;
        f.env.SCHEDULES.get = () => new TriggerSchedule(f.ctx, f.env);
        assert.equal((await f.call("/github_a/enabled", { enabled: true })).status, 200);
        assert.equal(f.values.get("plan").date, "2026-11-08");
        assert.equal(f.values.get("plan").last.result, "MISSED_DATE");
        await new TriggerSchedule(f.ctx, f.env).alarm();
        assert.equal(f.http.mock.callCount(), 0);
    });
}

test("reopen without PAT still skips elapsed plan before enable so later PAT repair cannot catch up", async (t) => {
    const f = fixture(t);
    await f.init();
    await f.call("/github_a/enabled", { enabled: false });
    f.setNow("2026-11-07T02:05:00+08:00");
    f.env.GITHUB_TOKEN_A = "";
    assert.equal((await f.call("/github_a/enabled", { enabled: true })).status, 200);
    assert.equal(f.values.get("plan").date, "2026-11-08");
    assert.equal(f.values.get("plan").last.result, "MISSED_DATE");
    assert.equal(f.alarm(), null);
    assert.equal((await (await f.call()).json()).targets[0].next_run, null);
    f.env.GITHUB_TOKEN_A = "github_pat_dummy_tests";
    await f.call("/github_a/enabled", { enabled: true });
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 0);
});

test("target identity changes ignore old persisted overrides and invalidate actionable old plan", async (t) => {
    const f = fixture(t);
    await f.init();
    await f.call("/github_a/enabled", { enabled: false });
    f.env.TRIGGER_CONFIG = config([target({ repository: "other/repo" })]);
    const state = (await (await f.call()).json()).targets[0];
    assert.equal(state.enabled, true);
    assert.equal(state.next_run, "2026-11-07T18:00:00.000Z");
    assert.equal(f.http.mock.callCount(), 0);
    await f.init();
    assert.equal(f.values.get("plan").last.result, "TARGET_CHANGED");
});

test("read retains future plan while rearming missing alarm and suppresses missing-PAT or elapsed plans", async (t) => {
    const f = fixture(t);
    await f.init();
    const before = structuredClone([...f.values]);
    const expected = "2026-11-06T18:00:00.000Z";
    await f.storage.deleteAlarm();
    assert.equal((await (await f.call()).json()).targets[0].next_run, expected);
    assert.equal(f.alarm(), f.values.get("plan").slots[0].at);
    assert.deepEqual([...f.values], before);
    f.env.GITHUB_TOKEN_A = "";
    assert.equal((await (await f.call()).json()).targets[0].next_run, null);
    assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 409);
    f.env.GITHUB_TOKEN_A = "github_pat_dummy_tests";
    f.setNow("2026-11-07T02:00:00+08:00");
    assert.equal((await (await f.call()).json()).targets[0].next_run, null);
});

test("manual persists UNKNOWN before business HTTP, shares bot outcome and never changes plan or alarm", async (t) => {
    const f = fixture(t);
    f.env.WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=dummy_private_webhook";
    await f.init();
    const plan = structuredClone(f.values.get("plan"));
    const alarm = f.alarm();
    // Inspect serialized storage directly inside HTTP: an admin read would wait behind the running DO request.
    f.http.mock.mockImplementation(async (url, options) => {
        const history = f.values.get("history").items;
        assert.equal(history[0].id, uuid());
        if (url.startsWith("https://api.github.com/")) {
            assert.equal(history[0].result, "DISPATCH_UNKNOWN");
            assert.equal(history[0].notification, "NOTIFY_UNKNOWN");
            assert.equal(f.values.get("receipts").items[0].record.result, "DISPATCH_UNKNOWN");
            assert.equal(options.headers.Authorization, "Bearer github_pat_dummy_tests");
            return new Response(null, { status: 204 });
        }
        assert.equal(history[0].result, "DISPATCH_ACCEPTED");
        assert.equal(history[0].notification, "NOTIFY_UNKNOWN");
        assert.ok(JSON.parse(options.body).text.content.includes("\u624b\u52a8"));
        return Response.json({ errcode: 0 });
    });
    const response = await f.call("/github_a/run", { request_id: uuid() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "DISPATCH_ACCEPTED", cached: false,
        record: { id: uuid(), at: Date.now(), source: "manual", result: "DISPATCH_ACCEPTED", notification: "NOTIFY_ACCEPTED" } });
    assert.deepEqual(f.values.get("plan"), plan);
    assert.equal(f.alarm(), alarm);
    assert.equal(f.http.mock.callCount(), 2);
    const raw = JSON.stringify([...f.values]);
    for (const privateValue of [access, f.env.GITHUB_TOKEN_A, "dummy_private_webhook", "GITHUB_TOKEN_A"])
        assert.equal(raw.includes(privateValue), false);
});

test("UUID fields reject trailing newline before namespace access", async (t) => {
    const f = fixture(t);
    assert.equal((await f.call("/github_a/run", { request_id: uuid() + "\n" })).status, 400);
    assert.equal((await f.call("/github_a/logs/delete", { log_id: uuid() + "\n" })).status, 400);
    assert.deepEqual(f.namespaceCalls, []);
    assert.equal(f.http.mock.callCount(), 0);
});

test("streamed JSON measures UTF-8 bytes, ignores misleading length and cancels excess input", async (t) => {
    const f = fixture(t);
    let cancelled = false;
    const oversized = new Request("https://unit.test/api/admin/targets/github_a/run", { method: "POST", duplex: "half",
        headers: { Authorization: "Basic " + Buffer.from("test-admin:dummy-long-secret-for-tests").toString("base64"), "Content-Type": "application/json", "Content-Length": "2" },
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("\u4e2d".repeat(342))); },
            cancel() { cancelled = true; } }) });
    assert.equal((await worker.fetch(oversized, f.env)).status, 413);
    assert.equal(cancelled, true);
    assert.deepEqual(f.namespaceCalls, []);
    const body = JSON.stringify({ request_id: uuid() });
    assert.equal((await f.call("/github_a/run", body + " ".repeat(1024 - body.length))).status, 200);
    const invalidUtf8 = new Request("https://unit.test/api/admin/targets/github_a/run", { method: "POST",
        headers: { Authorization: "Basic " + Buffer.from("test-admin:dummy-long-secret-for-tests").toString("base64"), "Content-Type": "application/json" },
        body: Uint8Array.from([0xff]) });
    assert.equal((await worker.fetch(invalidUtf8, f.env)).status, 400);
    assert.equal(f.http.mock.callCount(), 1);
});

test("simultaneous manual UUIDs serialize, coalesce identical requests and reject distinct requests in cooldown", async (t) => {
    const f = fixture(t);
    const results = await Promise.all([f.call("/github_a/run", { request_id: uuid() }),
        f.call("/github_a/run", { request_id: uuid() }), f.call("/github_a/run", { request_id: uuid(2) })]);
    assert.deepEqual(results.map((response) => response.status), [200, 200, 429]);
    assert.equal((await results[0].json()).cached, false);
    assert.equal((await results[1].json()).cached, true);
    assert.equal(f.http.mock.callCount(), 1);
});

test("manual crash after GitHub acceptance keeps receipt UNKNOWN and cannot resend or notify on restart", async (t) => {
    const f = fixture(t);
    const put = f.storage.put;
    f.storage.put = async (key, value) => {
        if (key === "receipts" && value.items[0].record.result === "DISPATCH_ACCEPTED") throw new Error("private_disk");
        return put(key, value);
    };
    assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 503);
    assert.equal(f.http.mock.callCount(), 1);
    f.storage.put = put;
    await f.call("/github_a/logs/clear", {});
    f.env.SCHEDULES.get = () => new TriggerSchedule(f.ctx, f.env);
    const response = await f.call("/github_a/run", { request_id: uuid() });
    assert.deepEqual(await response.json(), { status: "DISPATCH_UNKNOWN", cached: true,
        record: { id: uuid(), at: Date.now(), source: "manual", result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" } });
    assert.equal(f.http.mock.callCount(), 1);
});

test("manual crash after bot send preserves dispatch acceptance with unknown notification and no retry", async (t) => {
    const f = fixture(t);
    f.env.WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=dummy_webhook";
    f.http.mock.mockImplementation(async (url) => url.startsWith("https://api.github.com/")
        ? new Response(null, { status: 204 }) : Response.json({ errcode: 0 }));
    const put = f.storage.put;
    f.storage.put = async (key, value) => {
        if (key === "receipts" && value.items[0].record.notification === "NOTIFY_ACCEPTED") throw new Error("private_disk");
        return put(key, value);
    };
    assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 503);
    f.storage.put = put;
    const result = await (await f.call("/github_a/run", { request_id: uuid() })).json();
    assert.equal(result.status, "DISPATCH_ACCEPTED");
    assert.equal(result.record.notification, "NOTIFY_UNKNOWN");
    assert.equal(result.cached, true);
    assert.equal(f.http.mock.callCount(), 2);
});

test("failed atomic automatic history write leaves all records unchanged and permits one later attempt", async (t) => {
    const f = fixture(t);
    await f.init();
    f.setNow("2026-11-07T02:00:00+08:00");
    const put = f.storage.put;
    f.storage.put = async (key, value) => {
        const batch = typeof key === "object" ? key : { [key]: value };
        if (batch.history) throw new Error("private_disk");
        return put(key, value);
    };
    await assert.rejects(() => f.object.alarm());
    assert.equal(f.values.get("plan").slots[0].attempted, false);
    assert.equal(f.values.get("plan").slots[0].result, "PLANNED");
    assert.equal(f.values.has("automatic_guard"), false);
    assert.equal(f.values.has("history"), false);
    assert.equal(f.http.mock.callCount(), 0);
    f.storage.put = put;
    await new TriggerSchedule(f.ctx, f.env).alarm();
    await new TriggerSchedule(f.ctx, f.env).alarm();
    assert.equal(f.http.mock.callCount(), 1);
});

test("malformed stored known fields cannot expose private exception text or retry HTTP", async (t) => {
    const f = fixture(t);
    await f.call("/github_a/run", { request_id: uuid() });
    for (const poison of [
        { result: `DISPATCH_UNKNOWN\n${access}` }, { notification: access }, { extra: access }, { id: uuid() + "\n" },
        { at: Number.MAX_SAFE_INTEGER },
    ]) {
        const original = structuredClone(f.values.get("history"));
        f.values.set("history", { version: 1, items: [{ ...original.items[0], ...poison }] });
        const state = (await (await f.call()).json()).targets[0];
        assert.equal(state.error, "STATE_INVALID");
        assert.deepEqual(state.history, []);
        assert.equal(JSON.stringify(state).includes(access), false);
        f.values.set("history", original);
    }
    assert.equal(f.http.mock.callCount(), 1);
});

test("UUID retry is cached across single deletion, clear, restart and disabled target", async (t) => {
    const f = fixture(t);
    await f.init();
    const plan = structuredClone(f.values.get("plan"));
    await f.call("/github_a/run", { request_id: uuid() });
    assert.equal((await f.call("/github_a/logs/delete", { log_id: uuid() })).status, 200);
    assert.equal((await (await f.call()).json()).targets[0].history.length, 0);
    assert.equal((await (await f.call("/github_a/run", { request_id: uuid() })).json()).cached, true);
    await f.call("/github_a/logs/clear", {});
    f.env.SCHEDULES.get = () => new TriggerSchedule(f.ctx, f.env);
    await f.call("/github_a/enabled", { enabled: false });
    assert.equal((await (await f.call("/github_a/run", { request_id: uuid().toUpperCase() })).json()).cached, true);
    assert.equal(f.http.mock.callCount(), 1);
    assert.deepEqual(f.values.get("plan"), plan);
    assert.equal((await (await f.call()).json()).targets[0].history.length, 0);
    assert.equal((await f.call("/github_a/logs/delete", { log_id: uuid(2) })).status, 404);
});

test("distinct manual requests have thirty-second cooldown and twenty-record history cap", async (t) => {
    const f = fixture(t);
    assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 200);
    f.advance(29_999);
    assert.equal((await f.call("/github_a/run", { request_id: uuid(2) })).status, 429);
    f.advance(1);
    assert.equal((await f.call("/github_a/run", { request_id: uuid(2) })).status, 200);
    for (let n = 3; n <= 21; n++) {
        f.advance(30_000);
        assert.equal((await f.call("/github_a/run", { request_id: uuid(n) })).status, 200);
    }
    const history = (await (await f.call()).json()).targets[0].history;
    assert.equal(history.length, 20);
    assert.equal(history[0].id, uuid(21));
    assert.equal(history.at(-1).id, uuid(2));
    assert.equal((await (await f.call("/github_a/run", { request_id: uuid() })).json()).cached, true);
    assert.equal(f.http.mock.callCount(), 21);
    assert.equal(f.values.has("plan"), true);
    assert.equal(f.alarm(), f.values.get("plan").slots[0].at);
});

test("valid receipts never evict at capacity and expire after twenty-four hours", async (t) => {
    const f = fixture(t);
    for (let n = 1; n <= 100; n++) {
        assert.equal((await f.call("/github_a/run", { request_id: uuid(n) })).status, 200);
        f.advance(30_000);
    }
    const denied = await f.call("/github_a/run", { request_id: uuid(101) });
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { status: "RECEIPTS_FULL" });
    assert.equal((await (await f.call("/github_a/run", { request_id: uuid() })).json()).cached, true);
    assert.equal(f.http.mock.callCount(), 100);
    f.setNow(Date.parse("2026-11-07T00:05:00+08:00") + 86_400_000);
    assert.equal((await f.call("/github_a/run", { request_id: uuid(101) })).status, 200);
    assert.equal(f.values.get("receipts").items.length, 100);
    assert.equal(f.http.mock.callCount(), 101);
});

test("unknown HTTP result and lost response never automatically retry on same UUID", async (t) => {
    const f = fixture(t);
    f.http.mock.mockImplementation(async () => { throw new Error(`private_exception ${access}`); });
    const first = await f.call("/github_a/run", { request_id: uuid() });
    assert.equal((await first.json()).status, "DISPATCH_UNKNOWN");
    await f.call("/github_a/logs/clear", {});
    assert.equal((await (await f.call("/github_a/run", { request_id: uuid() })).json()).status, "DISPATCH_UNKNOWN");
    assert.equal(f.http.mock.callCount(), 1);
    assert.equal(JSON.stringify([...f.values]).includes("private_exception"), false);
});

test("failed before-HTTP receipt or history persistence cannot send and uncertain stored receipt never resends", async (t) => {
    const f = fixture(t);
    const put = f.storage.put;
    let failing = "receipts";
    f.storage.put = async (key, value) => {
        if (key === failing) throw new Error(`private_disk ${access}`);
        return put(key, value);
    };
    assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 503);
    assert.equal(f.http.mock.callCount(), 0);
    failing = "history";
    assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 503);
    assert.equal(f.http.mock.callCount(), 0);
    failing = null;
    const response = await f.call("/github_a/run", { request_id: uuid() });
    assert.equal((await response.json()).record.result, "DISPATCH_UNKNOWN");
    assert.equal(f.http.mock.callCount(), 0);
});

test("manual UUID cannot be reused against changed target binding within retention", async (t) => {
    const f = fixture(t);
    await f.call("/github_a/run", { request_id: uuid() });
    f.env.TRIGGER_CONFIG = config([target({ repository: "other/repo" })]);
    const response = await f.call("/github_a/run", { request_id: uuid() });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { status: "REQUEST_CONFLICT" });
    assert.equal(f.http.mock.callCount(), 1);
});

test("automatic history UNKNOWN is linked to persisted plan before HTTP and shares safe result schema", async (t) => {
    const f = fixture(t);
    await f.init();
    f.setNow("2026-11-07T02:00:00+08:00");
    f.http.mock.mockImplementation(async () => {
        const record = f.values.get("history").items[0];
        assert.equal(record.id, f.values.get("plan").slots[0].history_id);
        assert.equal(record.result, "DISPATCH_UNKNOWN");
        assert.equal(record.notification, "NOTIFY_UNKNOWN");
        assert.equal(record.source, "automatic");
        return new Response(null, { status: 403 });
    });
    await f.object.alarm();
    const state = (await (await f.call()).json()).targets[0];
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].result, "DISPATCH_HTTP_403");
    assert.equal(state.history[0].notification, "NOTIFY_NOT_CONFIGURED");
    assert.equal(f.values.has("receipts"), false);
    await f.object.alarm();
    assert.equal(f.http.mock.callCount(), 1);
});

test("corrupt control history receipts and plans yield generic state errors with no writes or dispatch", async (t) => {
    const f = fixture(t);
    for (const key of ["control", "history", "receipts", "plan"]) {
        f.values.clear();
        f.values.set(key, { private_value: access });
        const before = structuredClone([...f.values]);
        const response = await f.call();
        assert.equal(response.status, 200);
        const state = (await response.json()).targets[0];
        assert.equal(state.error, "STATE_INVALID");
        assert.equal(state.next_run, null);
        assert.deepEqual(state.history, []);
        assert.equal((await f.call("/github_a/run", { request_id: uuid() })).status, 503);
        assert.deepEqual([...f.values], before);
    }
    assert.equal(f.http.mock.callCount(), 0);
});

test("reserved bindings cannot act as GitHub PAT even with a valid PAT-shaped admin Secret", async (t) => {
    const f = fixture(t);
    for (const token_secret of ["DEBUG_ACCESS_TOKEN", "WECOM_WEBHOOK_URL", "TRIGGER_CONFIG", "SCHEDULES"]) {
        f.env.TRIGGER_CONFIG = config([target({ token_secret })]);
        if (token_secret === "WECOM_WEBHOOK_URL") f.env.WECOM_WEBHOOK_URL = access;
        const response = await f.call("/github_a/run", { request_id: uuid() });
        assert.equal(response.status, 409);
        assert.equal((await (await f.call()).json()).targets[0].token_state, "invalid");
        await f.init();
        assert.equal(f.alarm(), null);
    }
    assert.equal(f.http.mock.callCount(), 0);
});

test("maximum parser-valid binding persists control and receipts without treating its state as corrupt", async (t) => {
    const f = fixture(t, { targets: [target({ repository: `${"o".repeat(100)}/${"r".repeat(100)}`,
        workflow: `${"w".repeat(100)}.yaml`, ref: "r".repeat(200) })] });
    const enabled = await f.call("/github_a/enabled", { enabled: true });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).target.error, null);
    const run = await f.call("/github_a/run", { request_id: uuid() });
    assert.equal(run.status, 200);
    assert.equal((await (await f.call()).json()).targets[0].error, null);
    assert.equal((await (await f.call("/github_a/run", { request_id: uuid() })).json()).cached, true);
    assert.equal(f.http.mock.callCount(), 1);
});

test("control storage outage propagates safely instead of being mislabeled config-invalid and deleting alarm", async (t) => {
    const f = fixture(t);
    await f.init();
    const alarm = f.alarm();
    const get = f.storage.get;
    f.storage.get = async (key) => {
        if (key === "control") throw new Error(`private_storage ${access}`);
        return get(key);
    };
    await assert.rejects(() => f.object.alarm());
    assert.equal(f.alarm(), alarm);
    assert.equal(f.http.mock.callCount(), 0);
    const response = await f.call();
    assert.equal((await response.json()).targets[0].error, "STORAGE_UNAVAILABLE");
});
