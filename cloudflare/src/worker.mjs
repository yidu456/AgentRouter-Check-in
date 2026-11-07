const DAY = 86_400_000;
const MINUTE = 60_000;
const SHANGHAI_OFFSET = 8 * 60 * MINUTE;
const MINUTES_IN_WINDOW = 1321;
const TARGET_KEYS = ["id", "repository", "workflow", "ref", "token_secret", "enabled"];

function invalidConfig() { throw new Error("CONFIG_INVALID"); }

function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseConfig(raw) {
    if (raw === undefined) return [];
    let config;
    try {
        if (typeof raw !== "string" || raw.length > 64_000) invalidConfig();
        config = JSON.parse(raw);
    } catch { invalidConfig(); }
    if (!exactKeys(config, ["version", "targets"]) || config.version !== 1
            || !Array.isArray(config.targets) || config.targets.length > 100) invalidConfig();
    const ids = new Set();
    const bindings = new Set();
    for (const target of config.targets) {
        if (!exactKeys(target, TARGET_KEYS)
                || typeof target.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.id)
                || typeof target.repository !== "string"
                || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(target.repository)
                || typeof target.workflow !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(target.workflow)
                || typeof target.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target.ref)
                || /\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(target.ref)
                || typeof target.token_secret !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(target.token_secret)
                || typeof target.enabled !== "boolean") invalidConfig();
        const binding = targetBinding(target);
        if (ids.has(target.id) || bindings.has(binding)) invalidConfig();
        ids.add(target.id);
        bindings.add(binding);
    }
    return config.targets;
}

function targetBinding(target) {
    return JSON.stringify([target.repository.toLowerCase(), target.workflow, target.ref]);
}

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

function tokenFor(target, env) {
    const token = env[target.token_secret];
    return typeof token === "string" && /^[A-Za-z0-9_]{10,255}$/.test(token) ? token : null;
}

function logResult(id, date, result) { console.log(`TRIGGER ${id} ${date} ${result}`); }

export class TriggerSchedule {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }

    async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/init") return new Response(null, { status: 404 });
        return this.ctx.blockConcurrencyWhile(async () => {
            const id = url.searchParams.get("id");
            const selected = await this.select(id);
            if (!selected) return new Response(null, { status: 200 });
            const plan = await this.readPlan();
            const now = Date.now();
            if (!plan) await this.planNext(selected.target, null, now);
            else if (plan.id !== id || plan.binding !== targetBinding(selected.target)) {
                await this.finish(plan, "TARGET_CHANGED");
                await this.planNext(selected.target, plan, now, true);
            } else if (plan.attempted) await this.planNext(selected.target, plan, now, true);
            else if (plan.date < localDate(now)) {
                await this.finish(plan, "MISSED_DATE");
                await this.planNext(selected.target, plan, now, true);
            } else await this.ctx.storage.setAlarm(Math.max(plan.at, now + 1));
            return new Response(null, { status: 200 });
        });
    }

    async select(id) {
        let target;
        let reason;
        try {
            target = parseConfig(this.env.TRIGGER_CONFIG).find((item) => item.id === id);
            reason = !target ? "TARGET_REMOVED" : !target.enabled ? "TARGET_DISABLED"
                : !tokenFor(target, this.env) ? "TOKEN_MISSING" : null;
        } catch { reason = "CONFIG_INVALID"; }
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

    async planNext(target, previous, now, afterPrevious = false) {
        let date = eligibleDate(now);
        if (afterPrevious && previous && date <= previous.date) date = nextDate(previous.date);
        const plan = { version: 1, id: target.id, binding: targetBinding(target), date,
            at: dayStart(date) + (60 + randomMinute()) * MINUTE,
            attempted: false, result: "PLANNED" };
        if (previous) plan.last = { date: previous.date, at: previous.at, result: previous.result };
        await this.ctx.storage.put("plan", plan);
        await this.ctx.storage.setAlarm(plan.at);
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
            // Commit uncertainty before HTTP: a crash or timeout must not cause a resend.
            await this.finish(plan, "DISPATCH_UNKNOWN");
            let result = "DISPATCH_UNKNOWN";
            try {
                const [owner, repository] = target.repository.split("/");
                const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
                    + `/actions/workflows/${encodeURIComponent(target.workflow)}/dispatches`;
                const response = await fetch(url, { method: "POST", redirect: "manual",
                    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
                        "Content-Type": "application/json", "User-Agent": "agentrouter-trigger",
                        "X-GitHub-Api-Version": "2022-11-28" },
                    body: JSON.stringify({ ref: target.ref }), signal: AbortSignal.timeout(10_000) });
                result = response.status === 200 || response.status === 204 ? "DISPATCH_ACCEPTED"
                    : `DISPATCH_HTTP_${response.status}`;
            } catch { /* Unknown delivery is deliberately not retried. */ }
            await this.finish(plan, result);
            await this.planNext(target, plan, Date.now(), true);
        });
    }
}

export default {
    async fetch() { return new Response(null, { status: 404 }); },
    async scheduled(_event, env) {
        let targets;
        try { targets = parseConfig(env.TRIGGER_CONFIG); }
        catch { logResult("config", "-", "CONFIG_INVALID"); return; }
        for (const target of targets) {
            if (!target.enabled) continue;
            try {
                const stub = env.SCHEDULES.get(env.SCHEDULES.idFromName(`v1:${target.id}`));
                const response = await stub.fetch(new Request(`https://scheduler.internal/init?id=${target.id}`, { method: "POST" }));
                if (response.status !== 200) logResult(target.id, "-", "INIT_FAIL");
            } catch { logResult(target.id, "-", "INIT_FAIL"); }
        }
    },
};
