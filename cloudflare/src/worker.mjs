import { parseConfig, targetBinding, tokenFor } from "./config.mjs";
import { statusResponse } from "./status.mjs";
import { sendTriggerNotification } from "./wecom.mjs";
import { adminResponse, adminGate, adminJson, mutationBody, targetState, UUID } from "./admin.mjs";
export { parseConfig } from "./config.mjs";

const DAY = 86_400_000;
const MINUTE = 60_000;
const SHANGHAI_OFFSET = 8 * 60 * MINUTE;
const MINUTES_IN_WINDOW = 1321;
export function randomMinute() {
    // Rejection sampling avoids modulo bias without correlating days or targets.
    const ceiling = Math.floor(0x1_0000_0000 / MINUTES_IN_WINDOW) * MINUTES_IN_WINDOW;
    const bytes = new Uint32Array(1);
    do { crypto.getRandomValues(bytes); } while (bytes[0] >= ceiling);
    return bytes[0] % MINUTES_IN_WINDOW;
}

function localDate(now) { return new Date(now + SHANGHAI_OFFSET).toISOString().slice(0, 10); }
function dayStart(date) { return Date.parse(`${date}T00:00:00+08:00`); }
function nextDate(date) { return localDate(dayStart(date) + DAY); }
function eligibleDate(now) {
    const date = localDate(now);
    return now < dayStart(date) + 60 * MINUTE ? date : nextDate(date);
}

function validPlan(plan) {
    return plan && plan.version === 1 && typeof plan.id === "string" && typeof plan.binding === "string"
        && typeof plan.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(plan.date)
        && Number.isFinite(dayStart(plan.date)) && localDate(dayStart(plan.date)) === plan.date
        && Number.isSafeInteger(plan.at) && plan.at >= dayStart(plan.date) + 60 * MINUTE
        && plan.at <= dayStart(plan.date) + 23 * 60 * MINUTE && plan.at % MINUTE === 0
        && typeof plan.attempted === "boolean" && typeof plan.result === "string";
}

function logResult(id, date, result) { console.log(`TRIGGER ${id} ${date} ${result}`); }

const NOTIFICATIONS = ["NOTIFY_UNKNOWN", "NOTIFY_ACCEPTED", "NOTIFY_FAILED", "NOTIFY_NOT_CONFIGURED", "NOTIFY_CONFIG_INVALID"];
function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validRecord(record) {
    return exactKeys(record, ["id", "at", "source", "result", "notification"])
        && typeof record.id === "string" && record.id.length === 36 && UUID.test(record.id) && record.id === record.id.toLowerCase()
        && Number.isSafeInteger(record.at) && record.at >= 0 && record.at <= 8_640_000_000_000_000
        && ["automatic", "manual"].includes(record.source)
        && typeof record.result === "string" && /^(DISPATCH_ACCEPTED|DISPATCH_UNKNOWN|DISPATCH_HTTP_[1-5]\d{2})$/.test(record.result)
        && !/\s/.test(record.result) && NOTIFICATIONS.includes(record.notification);
}
function validControl(control) {
    return exactKeys(control, ["version", "binding", "enabled"]) && control.version === 1
        && typeof control.binding === "string" && control.binding.length <= 1024 && typeof control.enabled === "boolean";
}
function validHistory(history) {
    return exactKeys(history, ["version", "items"]) && history.version === 1 && Array.isArray(history.items)
        && history.items.length <= 20 && history.items.every(validRecord)
        && new Set(history.items.map((record) => record.id)).size === history.items.length;
}
function validReceipts(receipts) {
    return exactKeys(receipts, ["version", "items", "last_at"]) && receipts.version === 1
        && Number.isSafeInteger(receipts.last_at) && receipts.last_at >= 0 && receipts.last_at <= 8_640_000_000_000_000
        && Array.isArray(receipts.items)
        && receipts.items.length <= 100 && receipts.items.every((item) => exactKeys(item, ["binding", "record"])
            && typeof item.binding === "string" && item.binding.length <= 1024
            && validRecord(item.record) && item.record.source === "manual")
        && new Set(receipts.items.map((item) => item.record.id)).size === receipts.items.length;
}
function updateHistory(history, record) {
    const index = history.items.findIndex((item) => item.id === record.id);
    if (index === -1) history.items.unshift({ ...record });
    else history.items[index] = { ...record };
    history.items = history.items.slice(0, 20);
}

export class TriggerSchedule {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/admin/")) {
            const denied = await adminGate(request, this.env);
            if (denied) return denied;
            const action = url.pathname.slice(7);
            const listing = action === "state" && request.method === "GET";
            if (!listing && (request.method !== "POST" || !["enabled", "run", "logs/delete", "logs/clear"].includes(action)))
                return adminJson({ status: "NOT_FOUND" }, 404);
            const body = listing ? null : await mutationBody(request, action);
            if (body instanceof Response) return body;
            return this.ctx.blockConcurrencyWhile(async () => {
                let target;
                try { target = parseConfig(this.env.TRIGGER_CONFIG).find((item) => item.id === url.searchParams.get("id")); }
                catch { return adminJson({ status: "CONFIG_INVALID" }, 503); }
                if (!target) return adminJson({ status: "TARGET_NOT_FOUND" }, 404);
                try {
                    let state = await this.snapshot();
                    if (listing) {
                        if (!state.plan && this.enabled(target, state.control) && tokenFor(target, this.env)) {
                            await this.initialize(target);
                            state = await this.snapshot();
                        } else if (state.plan && this.enabled(target, state.control) && tokenFor(target, this.env)
                                && state.plan.id === target.id && state.plan.binding === targetBinding(target)
                                && !state.plan.attempted && state.plan.at > Date.now()
                                && await this.ctx.storage.getAlarm() === null) {
                            await this.ctx.storage.setAlarm(state.plan.at);
                        }
                        return adminJson(this.describe(target, state));
                    }
                    return await this.mutate(target, state, action, body);
                } catch (error) {
                    const code = error?.message === "STATE_INVALID" ? "STATE_INVALID" : "STORAGE_UNAVAILABLE";
                    return listing ? adminJson({ ...targetState(target, this.env), error: code }) : adminJson({ status: code }, 503);
                }
            });
        }
        if (request.method !== "POST" || url.pathname !== "/init") return new Response(null, { status: 404 });
        return this.ctx.blockConcurrencyWhile(async () => {
            const id = url.searchParams.get("id");
            const selected = await this.select(id);
            if (!selected) return new Response(null, { status: 200 });
            await this.initialize(selected.target);
            return new Response(null, { status: 200 });
        });
    }

    async snapshot() {
        const [control, history, receipts, plan] = await Promise.all(["control", "history", "receipts", "plan"]
            .map((key) => this.ctx.storage.get(key)));
        if (control !== undefined && !validControl(control) || history !== undefined && !validHistory(history)
                || receipts !== undefined && !validReceipts(receipts) || plan !== undefined && !validPlan(plan))
            throw new Error("STATE_INVALID");
        return { control, history: history ?? { version: 1, items: [] },
            receipts: receipts ?? { version: 1, items: [], last_at: 0 }, plan };
    }

    enabled(target, control) {
        return control?.binding === targetBinding(target) ? control.enabled : target.enabled;
    }

    describe(target, state) {
        const summary = targetState(target, this.env);
        summary.enabled = this.enabled(target, state.control);
        const plan = state.plan;
        if (summary.enabled && summary.token_state === "configured" && plan && plan.id === target.id
                && plan.binding === targetBinding(target) && !plan.attempted && plan.at > Date.now())
            summary.next_run = new Date(plan.at).toISOString();
        summary.history = state.history.items;
        return summary;
    }

    async initialize(target, reopening = false, arm = true) {
        const plan = await this.readPlan();
        const now = Date.now();
        if (!plan) await this.planNext(target, null, now, false, arm);
        else if (plan.id !== target.id || plan.binding !== targetBinding(target)) {
            await this.finish(plan, "TARGET_CHANGED");
            await this.planNext(target, plan, now, true, arm);
        } else if (plan.attempted) await this.planNext(target, plan, now, true, arm);
        else if (plan.date < localDate(now) || reopening && plan.at <= now) {
            await this.finish(plan, "MISSED_DATE");
            await this.planNext(target, plan, now, true, arm);
        } else if (arm) await this.ctx.storage.setAlarm(Math.max(plan.at, now + 1));
    }

    async mutate(target, state, action, body) {
        if (action === "enabled") {
            const wasEnabled = this.enabled(target, state.control);
            // Prepare skipped/replanned state while paused so a failed reopen cannot permit catch-up.
            if (body.enabled && !wasEnabled) await this.initialize(target, true, false);
            await this.ctx.storage.put("control", { version: 1, binding: targetBinding(target), enabled: body.enabled });
            if (!body.enabled) await this.ctx.storage.deleteAlarm();
            else {
                const selected = await this.select(target.id);
                if (selected) await this.initialize(target);
            }
            return adminJson({ status: "ENABLED_UPDATED", target: this.describe(target, await this.snapshot()) });
        }
        if (action === "logs/delete" || action === "logs/clear") {
            if (action === "logs/delete") {
                const index = state.history.items.findIndex((record) => record.id === body.log_id.toLowerCase());
                if (index === -1) return adminJson({ status: "LOG_NOT_FOUND" }, 404);
                state.history.items.splice(index, 1);
            } else state.history.items = [];
            await this.ctx.storage.put("history", state.history);
            return adminJson({ status: action === "logs/delete" ? "HISTORY_DELETED" : "HISTORY_CLEARED" });
        }
        const now = Date.now();
        const id = body.request_id.toLowerCase();
        const receipts = state.receipts;
        receipts.items = receipts.items.filter((item) => now - item.record.at < DAY);
        const existing = receipts.items.find((item) => item.record.id === id);
        if (existing) {
            if (existing.binding !== targetBinding(target)) return adminJson({ status: "REQUEST_CONFLICT" }, 409);
            return adminJson({ status: existing.record.result, cached: true, record: existing.record });
        }
        if (!this.enabled(target, state.control)) return adminJson({ status: "TARGET_DISABLED" }, 409);
        const token = tokenFor(target, this.env);
        if (!token) return adminJson({ status: "TOKEN_MISSING" }, 409);
        if (receipts.items.length >= 100) return adminJson({ status: "RECEIPTS_FULL" }, 429);
        if (receipts.last_at > 0 && now - receipts.last_at < 30_000) return adminJson({ status: "COOLDOWN" }, 429);
        const record = { id, at: now, source: "manual", result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" };
        receipts.items.push({ binding: targetBinding(target), record });
        receipts.last_at = now;
        await this.dispatch(target, token, record, async (value) => {
            receipts.items.find((item) => item.record.id === id).record = { ...value };
            // Keep receipts separate: deleting visible history must never make a UUID resendable.
            await this.ctx.storage.put("receipts", receipts);
            updateHistory(state.history, value);
            await this.ctx.storage.put("history", state.history);
        }, localDate(now));
        return adminJson({ status: record.result, cached: false, record });
    }

    async dispatch(target, token, record, save, date) {
        // Persist uncertainty before HTTP; neither GitHub nor bot delivery is retried.
        await save(record);
        try {
            const [owner, repository] = target.repository.split("/");
            const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
                + `/actions/workflows/${encodeURIComponent(target.workflow)}/dispatches`;
            const response = await fetch(url, { method: "POST", redirect: "manual",
                headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
                    "Content-Type": "application/json", "User-Agent": "agentrouter-trigger",
                    "X-GitHub-Api-Version": "2022-11-28" },
                body: JSON.stringify({ ref: target.ref }), signal: AbortSignal.timeout(10_000) });
            record.result = response.status === 200 || response.status === 204 ? "DISPATCH_ACCEPTED"
                : Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
                    ? `DISPATCH_HTTP_${response.status}` : "DISPATCH_UNKNOWN";
        } catch { /* Unknown delivery is deliberately not retried. */ }
        await save(record);
        try { record.notification = await sendTriggerNotification(target, date, record.result, this.env, record.source); }
        catch { record.notification = "NOTIFY_UNKNOWN"; }
        if (!NOTIFICATIONS.includes(record.notification)) record.notification = "NOTIFY_UNKNOWN";
        await save(record);
        logResult(target.id, date, record.notification);
    }

    async select(id) {
        let target;
        let reason;
        try {
            target = parseConfig(this.env.TRIGGER_CONFIG).find((item) => item.id === id);
        } catch { reason = "CONFIG_INVALID"; }
        if (target) {
            const control = await this.ctx.storage.get("control");
            if (control !== undefined && !validControl(control)) {
                await this.ctx.storage.deleteAlarm();
                throw new Error("STATE_INVALID");
            }
            reason = !this.enabled(target, control) ? "TARGET_DISABLED"
                : !tokenFor(target, this.env) ? "TOKEN_MISSING" : null;
        } else reason ??= "TARGET_REMOVED";
        if (reason) {
            await this.ctx.storage.deleteAlarm();
            logResult(/^[A-Za-z0-9_-]{1,64}$/.test(id ?? "") ? id : "unknown", "-", reason);
            return null;
        }
        return { target, token: tokenFor(target, this.env) };
    }

    async readPlan() {
        const plan = await this.ctx.storage.get("plan");
        if (plan !== undefined && !validPlan(plan)) {
            await this.ctx.storage.deleteAlarm();
            throw new Error("STATE_INVALID");
        }
        return plan;
    }

    async finish(plan, result) {
        plan.attempted = true;
        plan.result = result;
        await this.ctx.storage.put("plan", plan);
        logResult(plan.id, plan.date, result);
    }

    async planNext(target, previous, now, afterPrevious = false, arm = true) {
        let date = eligibleDate(now);
        if (afterPrevious && previous && date <= previous.date) date = nextDate(previous.date);
        const plan = { version: 1, id: target.id, binding: targetBinding(target), date,
            at: dayStart(date) + (60 + randomMinute()) * MINUTE,
            attempted: false, result: "PLANNED" };
        if (previous) {
            plan.last = { date: previous.date, at: previous.at, result: previous.result };
            if (previous.notification) plan.last.notification = previous.notification;
        }
        await this.ctx.storage.put("plan", plan);
        if (arm) await this.ctx.storage.setAlarm(plan.at);
        console.log(`TRIGGER ${target.id} ${date} PLANNED ${new Date(plan.at).toISOString()}`);
    }

    async alarm() {
        return this.ctx.blockConcurrencyWhile(async () => {
            const plan = await this.readPlan();
            if (!plan) return;
            const selected = await this.select(plan.id);
            if (!selected) return;
            const { target, token } = selected;
            const now = Date.now();
            if (plan.binding !== targetBinding(target)) {
                await this.finish(plan, "TARGET_CHANGED");
                return this.planNext(target, plan, now, true);
            }
            if (plan.attempted) return this.planNext(target, plan, now, true);
            if (now < plan.at) return this.ctx.storage.setAlarm(plan.at);
            if (plan.date !== localDate(now)) {
                await this.finish(plan, "MISSED_DATE");
                return this.planNext(target, plan, now, true);
            }
            const history = await this.ctx.storage.get("history") ?? { version: 1, items: [] };
            if (!validHistory(history)) throw new Error("STATE_INVALID");
            const record = { id: crypto.randomUUID(), at: now, source: "automatic",
                result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" };
            await this.dispatch(target, token, record, async (value) => {
                plan.history_id = value.id;
                plan.notification = value.notification;
                await this.finish(plan, value.result);
                updateHistory(history, value);
                await this.ctx.storage.put("history", history);
            }, plan.date);
            await this.planNext(target, plan, Date.now(), true);
        });
    }
}

export default {
    async fetch(request, env) { return await adminResponse(request, env) ?? statusResponse(request, env); },
    async scheduled(_event, env) {
        let targets;
        try { targets = parseConfig(env.TRIGGER_CONFIG); }
        catch { logResult("config", "-", "CONFIG_INVALID"); return; }
        for (const target of targets) {
            try {
                const stub = env.SCHEDULES.get(env.SCHEDULES.idFromName(`v1:${target.id}`));
                const response = await stub.fetch(new Request(`https://scheduler.internal/init?id=${target.id}`, { method: "POST" }));
                if (response.status !== 200) logResult(target.id, "-", "INIT_FAIL");
            } catch { logResult(target.id, "-", "INIT_FAIL"); }
        }
    },
};
