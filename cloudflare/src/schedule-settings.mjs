import { normalizeSchedule, targetBinding } from "./config.mjs";

export const settingsBinding = target => JSON.stringify([target.id, targetBinding(target)]);
function exactKeys(value, keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validSettings(value) {
    if (!exactKeys(value, ["version", "binding", "revision", "schedule"]) || value.version !== 1
        || typeof value.binding !== "string" || value.binding.length > 1024
        || !Number.isSafeInteger(value.revision) || value.revision < 1) return false;
    if (value.schedule === null) return true;
    try {
        const canonical = normalizeSchedule(value.schedule);
        return Object.hasOwn(canonical, "min_interval_minutes") === Object.hasOwn(value.schedule, "min_interval_minutes")
            && (canonical.mode !== "fixed" || [...value.schedule.times].every(time => typeof time === "string")
                && JSON.stringify(canonical.times) === JSON.stringify(value.schedule.times));
    } catch { return false; }
}

export function validGuard(value) {
    return exactKeys(value, ["version", "binding", "last_at"]) && value.version === 1
        && typeof value.binding === "string" && value.binding.length <= 1024
        && Number.isSafeInteger(value.last_at) && value.last_at >= 0 && value.last_at <= 8_640_000_000_000_000;
}

export function effectiveTarget(target, settings) {
    return settings?.binding === settingsBinding(target) && settings.schedule !== null
        ? { ...target, schedule: settings.schedule } : target;
}

export function settingsState(target, settings) {
    const matched = settings?.binding === settingsBinding(target);
    return { schedule_source: matched && settings.schedule !== null ? "database" : "variable",
        schedule_revision: matched ? settings.revision : 0, target_binding: settingsBinding(target) };
}
