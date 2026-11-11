import { intervalMinutes, scheduleFor, targetBinding, timeMinute } from "./config.mjs";

export const DAY = 86400000;
export const MINUTE = 60000;
export const localDate = now => new Date(now + 8 * 60 * MINUTE).toISOString().slice(0, 10);
export const dayStart = date => Date.parse(`${date}T00:00:00+08:00`);
export const nextDate = date => localDate(dayStart(date) + DAY);
export const planBinding = target => JSON.stringify([targetBinding(target), scheduleFor(target)]);
export const pendingSlot = (plan, after = -Infinity) => plan?.slots.find(slot => !slot.attempted && slot.at > after);

export function samePlanTarget(plan, target) {
    if (plan.id !== target.id) return false;
    const binding = targetBinding(target);
    if (plan.binding === binding) return true;
    try {
        const saved = JSON.parse(plan.binding);
        return Array.isArray(saved) && saved.length === 2 && saved[0] === binding;
    } catch { return false; }
}

export function randomMinute(size = 1321) {
    if (!Number.isInteger(size) || size < 1 || size > 1440) throw new Error("STATE_INVALID");
    const ceiling = Math.floor(0x100000000 / size) * size;
    const bytes = new Uint32Array(1);
    do { crypto.getRandomValues(bytes); } while (bytes[0] >= ceiling);
    return bytes[0] % size;
}

const resultValid = result => typeof result === "string"
    && /^(PLANNED|MISSED_DATE|TARGET_CHANGED|INTERVAL_SKIPPED|DISPATCH_ACCEPTED|DISPATCH_UNKNOWN|DISPATCH_HTTP_[1-5]\d{2})$/.test(result)
    && !/\s/.test(result);
const notificationValid = value => ["NOTIFY_UNKNOWN", "NOTIFY_ACCEPTED", "NOTIFY_FAILED", "NOTIFY_NOT_CONFIGURED", "NOTIFY_CONFIG_INVALID"].includes(value);
const dateValid = date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && date.length === 10 && Number.isFinite(dayStart(date)) && localDate(dayStart(date)) === date;
function slotValid(slot, date) {
    return slot && typeof slot === "object" && !Array.isArray(slot)
        && Object.keys(slot).every(k => ["at", "attempted", "result", "history_id", "notification"].includes(k))
        && Number.isSafeInteger(slot.at) && slot.at >= dayStart(date) && slot.at < dayStart(date) + DAY
        && slot.at % MINUTE === 0 && typeof slot.attempted === "boolean" && resultValid(slot.result)
        && (slot.attempted ? slot.result !== "PLANNED" : slot.result === "PLANNED")
        && (!Object.hasOwn(slot, "history_id") || typeof slot.history_id === "string" && slot.history_id.length === 36
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(slot.history_id))
        && (!Object.hasOwn(slot, "notification") || notificationValid(slot.notification));
}

export function validPlan(plan) {
    if (!plan || typeof plan.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(plan.id)
        || /\s/.test(plan.id) || typeof plan.binding !== "string" || plan.binding.length > 2048 || !dateValid(plan.date)) return false;
    if (plan.version === 1) return Number.isSafeInteger(plan.at) && plan.at >= dayStart(plan.date) + 60 * MINUTE
        && plan.at <= dayStart(plan.date) + 23 * 60 * MINUTE && plan.at % MINUTE === 0
        && typeof plan.attempted === "boolean" && resultValid(plan.result);
    return plan.version === 2 && Object.keys(plan).every(k => ["version", "id", "binding", "date", "slots", "last"].includes(k))
        && Array.isArray(plan.slots) && plan.slots.length >= 1 && plan.slots.length <= 24
        && [...plan.slots].every((slot, i) => slotValid(slot, plan.date) && (i === 0 || slot.at > plan.slots[i - 1].at))
        && (!Object.hasOwn(plan, "last") || plan.last && dateValid(plan.last.date)
            && Number.isSafeInteger(plan.last.at) && plan.last.at >= dayStart(plan.last.date) && plan.last.at < dayStart(plan.last.date) + DAY
            && resultValid(plan.last.result) && Object.keys(plan.last).every(k => ["date", "at", "result", "notification"].includes(k))
            && (!Object.hasOwn(plan.last, "notification") || notificationValid(plan.last.notification)));
}

export function migratePlan(plan, target) {
    if (plan.version === 2) return plan;
    const legacyDefault = JSON.stringify(scheduleFor(target)) === JSON.stringify(scheduleFor({}));
    const slot = { at: plan.at, attempted: plan.attempted, result: plan.result };
    for (const key of ["history_id", "notification"]) if (Object.hasOwn(plan, key)) slot[key] = plan[key];
    const migrated = { version: 2, id: plan.id,
        binding: legacyDefault && plan.binding === targetBinding(target) ? planBinding(target) : plan.binding,
        date: plan.date, slots: [slot], ...(plan.last ? { last: plan.last } : {}) };
    if (!validPlan(migrated)) throw new Error("STATE_INVALID");
    return migrated;
}

export function createPlan(target, previous, now, afterPrevious = false, earliest = now) {
    const schedule = scheduleFor(target), planningNow = Math.max(now, earliest - 1), today = localDate(planningNow);
    const clipWindow = earliest > now && schedule.mode === "random" && schedule.count === 1 && intervalMinutes(schedule) > 1440;
    let date;
    if (schedule.mode === "fixed") date = schedule.times.some(t => dayStart(today) + timeMinute(t) * MINUTE > planningNow) ? today : nextDate(today);
    else date = planningNow < dayStart(today) + timeMinute(clipWindow ? schedule.window.end : schedule.window.start) * MINUTE ? today : nextDate(today);
    if (afterPrevious && previous && date <= previous.date) date = nextDate(previous.date);
    let minutes;
    if (schedule.mode === "fixed") minutes = schedule.times.map(timeMinute);
    else {
        // A known future interval horizon can use the remaining one-slot window, never earlier minutes.
        const start = clipWindow && date === localDate(earliest)
            ? Math.max(timeMinute(schedule.window.start), Math.ceil((earliest - dayStart(date)) / MINUTE))
            : timeMinute(schedule.window.start);
        const end = timeMinute(schedule.window.end);
        const gap = intervalMinutes(schedule), size = end - start + 1 - (schedule.count - 1) * (gap - 1);
        // Sample compressed offsets, then restore the required gaps without retrying plans.
        const pool = Array.from({ length: size }, (_, i) => i);
        const draws = Array.from({ length: schedule.count }, () => pool.splice(randomMinute(pool.length), 1)[0]).sort((a, b) => a - b);
        minutes = draws.map((offset, i) => start + offset + i * (gap - 1));
    }
    const slots = minutes.map(minute => {
        const at = dayStart(date) + minute * MINUTE;
        return { at, attempted: at <= now, result: at <= now ? "MISSED_DATE" : "PLANNED" };
    });
    const plan = { version: 2, id: target.id, binding: planBinding(target), date, slots };
    if (previous) {
        const last = previous.slots.at(-1);
        plan.last = { date: previous.date, at: last.at, result: last.result };
        if (last.notification) plan.last.notification = last.notification;
    }
    return plan;
}
