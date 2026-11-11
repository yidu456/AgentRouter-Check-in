import { targetBinding, tokenFor, intervalMinutes, scheduleFor } from "./config.mjs";
import { statusResponse } from "./status.mjs";
import { sendTriggerNotification } from "./wecom.mjs";
import { adminResponse, adminGate, adminJson, mutationBody, targetState, UUID, basicAuthorized, adminState, loginState } from "./admin.mjs";
import { sessionStorageResponse } from "./sessions.mjs";
import { DAY, localDate, validPlan, planBinding, samePlanTarget, pendingSlot, migratePlan, createPlan } from "./scheduling.mjs";
import { settingsBinding, validSettings, validGuard, effectiveTarget, settingsState } from "./schedule-settings.mjs";
import { resolveTargets, storedCatalog, bootstrapCatalog, publicCatalog, saveCatalog, enableCatalogTarget } from "./target-catalog.mjs";
export { parseConfig } from "./config.mjs";
export { randomMinute } from "./scheduling.mjs";

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
        && history.items.length <= 20 && [...history.items].every(validRecord)
        && new Set(history.items.map((record) => record.id)).size === history.items.length;
}
function validReceipts(receipts) {
    return exactKeys(receipts, ["version", "items", "last_at"]) && receipts.version === 1
        && Number.isSafeInteger(receipts.last_at) && receipts.last_at >= 0 && receipts.last_at <= 8_640_000_000_000_000
        && Array.isArray(receipts.items)
        && receipts.items.length <= 100 && [...receipts.items].every((item) => exactKeys(item, ["binding", "record"])
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
        if (url.pathname === "/catalog/read" && request.method === "GET") {
            try { return adminJson(await storedCatalog(this.ctx.storage)); }
            catch { return adminJson({ status: "STATE_INVALID" }, 503); }
        }
        if (["/catalog/bootstrap", "/catalog/save", "/catalog/enabled"].includes(url.pathname)) {
            const denied = await adminGate(request, this.env);
            if (denied) return denied;
            const reading = url.pathname === "/catalog/bootstrap" && request.method === "GET";
            if (!reading && !(["/catalog/save", "/catalog/enabled"].includes(url.pathname) && request.method === "POST")) return adminJson({ status: "NOT_FOUND" }, 404);
            const body = reading ? null : await mutationBody(request, url.pathname === "/catalog/enabled" ? "enabled" : "catalog");
            if (body instanceof Response) return body;
            return this.ctx.blockConcurrencyWhile(async () => {
                try { return adminJson(reading ? publicCatalog(await bootstrapCatalog(this.ctx.storage, this.env), this.env)
                    : url.pathname === "/catalog/enabled" ? await enableCatalogTarget(this.ctx.storage, this.env, url.searchParams.get("id"), body.enabled)
                        : await saveCatalog(this.ctx.storage, this.env, body)); }
                catch (error) {
                    const codes = { CONFIG_INVALID: 503, STATE_INVALID: 503, TARGET_INVALID: 400, CREDENTIAL_INVALID: 400,
                        CATALOG_CONFLICT: 409, CATALOG_NOT_INITIALIZED: 409, TARGET_NOT_FOUND: 404,
                        CATALOG_REVISION_LIMIT: 429, CATALOG_FULL: 429 };
                    const code = Object.hasOwn(codes, error?.message ?? "") ? error.message : "STORAGE_UNAVAILABLE";
                    return adminJson({ status: code, ...(error?.diagnostic ? { error: error.diagnostic } : {}) }, codes[code] ?? 503);
                }
            });
        }
        if (url.pathname.startsWith("/session/")) {
            if (adminState(this.env) !== "configured") return adminJson({ status: "NOT_FOUND" }, 404);
            if (loginState(this.env) !== "configured") return adminJson({ status: "AUTH_NOT_CONFIGURED" }, 503);
            const response = await sessionStorageResponse(request, this.ctx, this.env, basicAuthorized);
            if (response) return response;
        }
        if (url.pathname.startsWith("/admin/")) {
            const denied = await adminGate(request, this.env);
            if (denied) return denied;
            const action = url.pathname.slice(7);
            const listing = action === "state" && request.method === "GET";
            if (!listing && (request.method !== "POST" || !["enabled", "run", "logs/delete", "logs/clear", "schedule", "schedule/reset"].includes(action)))
                return adminJson({ status: "NOT_FOUND" }, 404);
            const body = listing ? null : await mutationBody(request, action);
            if (body instanceof Response) return body;
            return this.ctx.blockConcurrencyWhile(async () => {
                let target;
                try { target = (await resolveTargets(this.env)).find((item) => item.id === url.searchParams.get("id")); }
                catch { return adminJson({ status: "CONFIG_INVALID" }, 503); }
                if (!target) return adminJson({ status: "TARGET_NOT_FOUND" }, 404);
                if (target.catalog_revision !== undefined && ["enabled", "schedule", "schedule/reset"].includes(action))
                    return adminJson({ status: "CATALOG_MANAGED" }, 409);
                try {
                    // Settings requests defer legacy guard persistence until the revision-bound commit.
                    let state = await this.snapshot(target, !["schedule", "schedule/reset"].includes(action));
                    if (listing) {
                        const effective = effectiveTarget(target, state.settings);
                        const active = this.enabled(effective, state.control) && tokenFor(effective, this.env);
                        if (!active) {
                            if (await this.ctx.storage.getAlarm() !== null) await this.ctx.storage.deleteAlarm();
                        } else if (state.catalogAdopted || !state.plan || state.plan.version === 1 || state.plan.binding !== planBinding(effective)) {
                            await this.initialize(target, state.catalogAdopted);
                            state = await this.snapshot(target);
                        } else if (state.plan.id === target.id && state.plan.binding === planBinding(effective)) {
                            const slot = pendingSlot(state.plan, Date.now());
                            if (slot && await this.ctx.storage.getAlarm() !== slot.at) await this.ctx.storage.setAlarm(slot.at);
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

    async snapshot(target, persistGuard = true) {
        let [control, history, receipts, plan, settings, savedGuard, seen] = await Promise.all(["control", "history", "receipts", "plan", "schedule_settings", "automatic_guard", "catalog_seen"]
            .map((key) => this.ctx.storage.get(key)));
        if (control !== undefined && !validControl(control) || history !== undefined && !validHistory(history)
                || receipts !== undefined && !validReceipts(receipts) || plan !== undefined && !validPlan(plan)
                || settings !== undefined && !validSettings(settings) || savedGuard !== undefined && !validGuard(savedGuard)
                || seen !== undefined && (!exactKeys(seen, ["version", "revision", "control_revision", "binding"]) || seen.version !== 1
                    || !Number.isSafeInteger(seen.revision) || seen.revision < 0 || !Number.isSafeInteger(seen.control_revision)
                    || seen.control_revision < 0 || typeof seen.binding !== "string" || seen.binding.length > 1024)) {
            await this.ctx.storage.deleteAlarm();
            throw new Error("STATE_INVALID");
        }
        let guard = savedGuard;
        if (!guard && target && plan && samePlanTarget(plan, target)) {
            const slots = plan.version === 1 ? [plan] : plan.slots;
            const linked = history?.items.filter(record => record.source === "automatic"
                && slots.some(slot => slot.attempted && slot.history_id === record.id
                    && /^DISPATCH_/.test(slot.result)));
            if (linked?.length)
                guard = { version: 1, binding: settingsBinding(target), last_at: Math.max(...linked.map(record => record.at)) };
        }
        let catalogAdopted = false;
        if (target?.catalog_revision !== undefined && (seen?.revision !== target.catalog_revision
            || seen?.control_revision !== target.control_revision || seen.binding !== settingsBinding(target))) {
            // Import is transparent; later edits atomically adopt the saved full target without erasing receipts/history.
            const edit = target.catalog_revision > 0 && (seen?.revision !== target.catalog_revision || seen?.binding !== settingsBinding(target));
            const enabledEdit = target.control_revision > 0 && seen?.control_revision !== target.control_revision;
            catalogAdopted = edit || enabledEdit;
            const batch = { catalog_seen: { version: 1, revision: target.catalog_revision, control_revision: target.control_revision,
                binding: settingsBinding(target) } };
            if (catalogAdopted)
                control = batch.control = { version: 1, binding: targetBinding(target), enabled: target.enabled };
            if (edit) {
                const matched = settings?.binding === settingsBinding(target);
                if (matched && settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("STATE_INVALID");
                settings = batch.schedule_settings = { version: 1, binding: settingsBinding(target),
                    revision: matched ? settings.revision + 1 : 1, schedule: null };
            }
            if (catalogAdopted) {
                const effective = effectiveTarget(target, settings), now = Date.now();
                if (plan?.version === 1) plan = migratePlan(plan, effective);
                if (plan?.binding === planBinding(effective)) {
                    for (const slot of plan.slots.filter(slot => !slot.attempted && slot.at <= now)) {
                        slot.attempted = true; slot.result = "MISSED_DATE";
                    }
                } else if (plan) {
                    for (const slot of plan.slots.filter(slot => !slot.attempted)) {
                        slot.attempted = true; slot.result = "TARGET_CHANGED";
                    }
                }
                if (!plan || plan.binding !== planBinding(effective) || !pendingSlot(plan, now))
                    plan = createPlan(effective, plan, now, false, this.earliest(effective, { guard }, now));
                // The no-catch-up plan and adoption marker commit together, including cron/Alarm-first reads.
                batch.plan = plan;
            }
            if (guard !== savedGuard) batch.automatic_guard = guard;
            await this.ctx.storage.put(batch);
        } else if (guard !== savedGuard && persistGuard) await this.ctx.storage.put("automatic_guard", guard);
        return { control, history: history ?? { version: 1, items: [] },
            receipts: receipts ?? { version: 1, items: [], last_at: 0 }, plan, settings, guard,
            guardRecovered: guard !== savedGuard, catalogAdopted };
    }

    enabled(target, control) {
        return control?.binding === targetBinding(target) ? control.enabled : target.enabled;
    }

    describe(target, state) {
        const metadata = settingsState(target, state.settings);
        target = effectiveTarget(target, state.settings);
        const summary = targetState(target, this.env);
        Object.assign(summary, metadata);
        if (state.guard?.binding === settingsBinding(target)) {
            summary.automatic_state = "known";
            summary.automatic_last_at = new Date(state.guard.last_at).toISOString();
            const next = state.guard.last_at + intervalMinutes(scheduleFor(target)) * 60_000;
            summary.automatic_next_allowed_at = next <= 8_640_000_000_000_000 ? new Date(next).toISOString() : null;
        }
        summary.enabled = this.enabled(target, state.control);
        const plan = state.plan;
        if (plan?.version === 2 && plan.id === target.id && plan.binding === planBinding(target)) {
            summary.schedule_date = plan.date;
            summary.slots = plan.slots.map(slot => ({ at: new Date(slot.at).toISOString(), attempted: slot.attempted, result: slot.result }));
            // Final-slot skips have no dispatch history; keep their reason visible after rollover.
            if (plan.last) summary.schedule_last = { date: plan.last.date, at: new Date(plan.last.at).toISOString(), result: plan.last.result };
            const slot = pendingSlot(plan, Date.now());
            if (summary.enabled && summary.token_state === "configured" && slot)
                summary.next_run = new Date(slot.at).toISOString();
        }
        summary.history = state.history.items;
        return summary;
    }

    async initialize(target, reopening = false, arm = true) {
        const state = await this.snapshot(target);
        target = effectiveTarget(target, state.settings);
        let plan = state.plan;
        const now = Date.now();
        if (plan?.version === 1) {
            plan = migratePlan(plan, target);
            await this.ctx.storage.put("plan", plan);
        }
        if (!plan) await this.planNext(target, null, now, false, arm);
        else if (plan.id !== target.id || plan.binding !== planBinding(target)) {
            await this.finish(plan, "TARGET_CHANGED");
            await this.planNext(target, plan, now, !target.schedule && !samePlanTarget(plan, target), arm);
        } else if (!pendingSlot(plan)) await this.planNext(target, plan, now, true, arm);
        else if (plan.date < localDate(now) || reopening && pendingSlot(plan).at <= now) {
            for (const slot of plan.slots.filter(slot => !slot.attempted && slot.at <= now))
                await this.finish(plan, "MISSED_DATE", slot);
            if (!pendingSlot(plan)) await this.planNext(target, plan, now, true, arm);
            else if (arm) await this.ctx.storage.setAlarm(pendingSlot(plan).at);
        } else if (arm) await this.ctx.storage.setAlarm(Math.max(pendingSlot(plan).at, now + 1));
    }

    async mutate(target, state, action, body) {
        if (action === "schedule" || action === "schedule/reset") {
            const metadata = settingsState(target, state.settings);
            if (body.binding !== metadata.target_binding) return adminJson({ status: "TARGET_CHANGED" }, 409);
            if (body.revision !== metadata.schedule_revision) return adminJson({ status: "SCHEDULE_CONFLICT" }, 409);
            if (metadata.schedule_revision === Number.MAX_SAFE_INTEGER)
                return adminJson({ status: "SCHEDULE_REVISION_LIMIT" }, 429);
            const settings = { version: 1, binding: metadata.target_binding, revision: metadata.schedule_revision + 1,
                schedule: action === "schedule" ? body.schedule : null };
            const effective = effectiveTarget(target, settings), now = Date.now();
            let plan = state.plan;
            if (plan?.version === 1) plan = migratePlan(plan, effective);
            if (!plan || plan.id !== effective.id || plan.binding !== planBinding(effective) || !pendingSlot(plan, now))
                plan = createPlan(effective, plan, now, false, this.earliest(effective, state, now));
            // Commit override and its plan together; Alarm repair must reuse these exact times.
            await this.ctx.storage.put({ schedule_settings: settings, plan,
                ...(state.guardRecovered ? { automatic_guard: state.guard } : {}) });
            const slot = pendingSlot(plan, now);
            if (this.enabled(effective, state.control) && tokenFor(effective, this.env) && slot)
                await this.ctx.storage.setAlarm(slot.at);
            else await this.ctx.storage.deleteAlarm();
            return adminJson({ status: action === "schedule" ? "SCHEDULE_UPDATED" : "SCHEDULE_RESET",
                target: this.describe(target, { ...state, settings, plan }) });
        }
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
            return adminJson({ status: "ENABLED_UPDATED", target: this.describe(target, await this.snapshot(target)) });
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
        target = effectiveTarget(target, state.settings);
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
            target = (await resolveTargets(this.env)).find((item) => item.id === id);
        } catch { reason = "CONFIG_INVALID"; }
        if (target) {
            const state = await this.snapshot(target);
            target = effectiveTarget(target, state.settings);
            reason = !this.enabled(target, state.control) ? "TARGET_DISABLED"
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

    async finish(plan, result, selected = null) {
        for (const slot of selected ? [selected] : plan.slots.filter(slot => !slot.attempted)) {
            slot.attempted = true;
            slot.result = result;
        }
        await this.ctx.storage.put("plan", plan);
        logResult(plan.id, plan.date, result);
    }

    async planNext(target, previous, now, afterPrevious = false, arm = true) {
        const state = await this.snapshot(target);
        const plan = createPlan(target, previous, now, afterPrevious, this.earliest(target, state, now));
        await this.ctx.storage.put("plan", plan);
        if (arm) await this.ctx.storage.setAlarm(pendingSlot(plan).at);
        console.log(`TRIGGER ${target.id} ${plan.date} PLANNED ${new Date(pendingSlot(plan).at).toISOString()}`);
    }

    earliest(target, state, now) {
        const gap = intervalMinutes(scheduleFor(target));
        return gap > 1440 && state.guard?.binding === settingsBinding(target)
            ? Math.max(now, state.guard.last_at + gap * 60_000) : now;
    }

    async alarm() {
        return this.ctx.blockConcurrencyWhile(async () => {
            let plan = await this.readPlan();
            if (!plan) return;
            const selected = await this.select(plan.id);
            if (!selected) return;
            plan = await this.readPlan();
            const { target, token } = selected;
            if (plan.version === 1) {
                plan = migratePlan(plan, target);
                await this.ctx.storage.put("plan", plan);
            }
            const now = Date.now();
            if (plan.binding !== planBinding(target)) {
                await this.finish(plan, "TARGET_CHANGED");
                return this.planNext(target, plan, now, !target.schedule && !samePlanTarget(plan, target));
            }
            if (!pendingSlot(plan)) return this.planNext(target, plan, now, true);
            if (now < pendingSlot(plan).at) return this.ctx.storage.setAlarm(pendingSlot(plan).at);
            if (plan.date !== localDate(now)) {
                await this.finish(plan, "MISSED_DATE");
                return this.planNext(target, plan, now, true);
            }
            const due = plan.slots.filter(slot => !slot.attempted && slot.at <= now);
            for (const slot of due.slice(0, -1)) await this.finish(plan, "MISSED_DATE", slot);
            const slot = due.at(-1);
            const state = await this.snapshot(target), attemptedAt = Date.now();
            const guard = state.guard?.binding === settingsBinding(target) ? state.guard : null;
            if (guard && attemptedAt < guard.last_at + intervalMinutes(scheduleFor(target)) * 60_000) {
                await this.finish(plan, "INTERVAL_SKIPPED", slot);
                if (pendingSlot(plan)) await this.ctx.storage.setAlarm(pendingSlot(plan).at);
                else await this.planNext(target, plan, Date.now(), true);
                return;
            }
            const checkpoint = { version: 1, binding: settingsBinding(target), last_at: attemptedAt };
            const record = { id: crypto.randomUUID(), at: attemptedAt, source: "automatic",
                result: "DISPATCH_UNKNOWN", notification: "NOTIFY_UNKNOWN" };
            await this.dispatch(target, token, record, async (value) => {
                slot.history_id = value.id;
                slot.notification = value.notification;
                slot.attempted = true;
                slot.result = value.result;
                updateHistory(state.history, value);
                await this.ctx.storage.put({ plan, automatic_guard: checkpoint, history: state.history });
                logResult(plan.id, plan.date, value.result);
            }, plan.date);
            if (pendingSlot(plan)) await this.ctx.storage.setAlarm(pendingSlot(plan).at);
            else await this.planNext(target, plan, Date.now(), true);
        });
    }
}

export default {
    async fetch(request, env) { return await adminResponse(request, env) ?? statusResponse(request, env); },
    async scheduled(_event, env) {
        let targets;
        try { targets = await resolveTargets(env); }
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
