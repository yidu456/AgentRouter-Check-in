const TARGET_KEYS = ["id", "repository", "workflow", "ref", "token_secret", "enabled"];

function invalid(field, code) {
    const error = new Error("CONFIG_INVALID");
    error.diagnostic = { field, code };
    throw error;
}

function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function targetBinding(target) {
    return JSON.stringify([target.repository.toLowerCase(), target.workflow, target.ref]);
}

export function timeMinute(value) {
    return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) && value.length === 5
        ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
}

export function normalizeSchedule(value, field = "schedule") {
    if (value?.mode === "fixed") {
        if (!exactKeys(value, ["mode", "times"])) invalid(field, "SCHEDULE_FIELDS");
        if (!Array.isArray(value.times) || value.times.length < 1 || value.times.length > 24)
            invalid(field + ".times", "SCHEDULE_COUNT");
        if (value.times.some(time => timeMinute(time) === null)) invalid(field + ".times", "SCHEDULE_TIME");
        if (new Set(value.times).size !== value.times.length) invalid(field + ".times", "SCHEDULE_DUPLICATE");
        return { mode: "fixed", times: [...value.times].sort() };
    }
    if (value?.mode === "random") {
        if (!exactKeys(value, ["mode", "count", "window"])) invalid(field, "SCHEDULE_FIELDS");
        if (!Number.isInteger(value.count) || value.count < 1 || value.count > 24)
            invalid(field + ".count", "SCHEDULE_COUNT");
        if (!exactKeys(value.window, ["start", "end"])) invalid(field + ".window", "SCHEDULE_FIELDS");
        const start = timeMinute(value.window.start), end = timeMinute(value.window.end);
        if (start === null || end === null || start > end) invalid(field + ".window", "SCHEDULE_TIME");
        if (value.count > end - start + 1) invalid(field + ".count", "SCHEDULE_CAPACITY");
        return { mode: "random", count: value.count, window: { start: value.window.start, end: value.window.end } };
    }
    invalid(field + ".mode", "SCHEDULE_MODE");
}

export function scheduleFor(target) {
    return target.schedule ?? { mode: "random", count: 1, window: { start: "01:00", end: "23:00" } };
}

function targetChecks(target) {
    const clean = value => typeof value === "string" && !/\s/.test(value);
    return {
        id: clean(target.id) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.id),
        repository: clean(target.repository) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(target.repository),
        workflow: clean(target.workflow) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(target.workflow),
        ref: clean(target.ref) && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target.ref)
            && !/\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(target.ref),
        token_secret: clean(target.token_secret) && /^[A-Z][A-Z0-9_]{0,63}$/.test(target.token_secret),
        enabled: typeof target.enabled === "boolean",
    };
}

export function parseConfig(raw) {
    if (raw === undefined) return [];
    if (typeof raw !== "string") invalid("TRIGGER_CONFIG", "JSON_TYPE");
    if (raw.length > 64_000) invalid("TRIGGER_CONFIG", "CONFIG_SIZE");
    let config;
    try { config = JSON.parse(raw); }
    catch { invalid("TRIGGER_CONFIG", "JSON_SYNTAX"); }
    if (!exactKeys(config, ["version", "targets"])) invalid("config", "CONFIG_FIELDS");
    if (config.version !== 1) invalid("version", "CONFIG_VERSION");
    if (!Array.isArray(config.targets) || config.targets.length > 100) invalid("targets", "TARGETS_INVALID");
    const ids = new Set();
    const bindings = new Set();
    for (const [index, target] of config.targets.entries()) {
        const field = `targets[${index}]`;
        if (target && typeof target === "object" && !Array.isArray(target) && !Object.hasOwn(target, "enabled"))
            target.enabled = true;
        if (!exactKeys(target, Object.hasOwn(target ?? {}, "schedule") ? [...TARGET_KEYS, "schedule"] : TARGET_KEYS))
            invalid(field, "TARGET_FIELDS");
        const checks = targetChecks(target);
        for (const [key, valid] of Object.entries(checks)) if (!valid) invalid(`${field}.${key}`, "TARGET_FIELD");
        if (Object.hasOwn(target, "schedule")) target.schedule = normalizeSchedule(target.schedule, field + ".schedule");
        const binding = targetBinding(target);
        if (ids.has(target.id)) invalid(`${field}.id`, "DUPLICATE_ID");
        if (bindings.has(binding)) invalid(`${field}.repository`, "DUPLICATE_TARGET");
        ids.add(target.id);
        bindings.add(binding);
    }
    return config.targets;
}

export function inspectConfig(raw) {
    let state = raw === undefined ? "missing" : "valid", error = null;
    try { parseConfig(raw); } catch (issue) { state = "invalid"; error = issue.diagnostic; }
    let config;
    try { config = typeof raw === "string" && raw.length <= 64000 ? JSON.parse(raw) : null; } catch { config = null; }
    const items = !Array.isArray(config?.targets) || config.targets.length > 100 ? [] : config.targets.map((source, index) => {
        const target = source && typeof source === "object" && !Array.isArray(source) ? { enabled: true, ...source } : {};
        const checks = targetChecks(target);
        const item = { index, error: null };
        for (const key of TARGET_KEYS) item[key] = checks[key] ? target[key] : null;
        try { item.schedule = Object.hasOwn(target, "schedule") ? normalizeSchedule(target.schedule)
            : source && typeof source === "object" && !Array.isArray(source) ? scheduleFor(target) : null; }
        catch { item.schedule = null; }
        try { parseConfig(JSON.stringify({ version: 1, targets: [source] })); }
        catch (issue) { item.error = { ...issue.diagnostic, field: issue.diagnostic.field.replace("targets[0]", `targets[${index}]`) }; }
        if (error?.field.startsWith(`targets[${index}]`)) item.error = error;
        return item;
    });
    return { state, error, items };
}

export function tokenFor(target, env) {
    if (["DEBUG_ACCESS_TOKEN", "ADMIN_USERNAME", "ADMIN_PASSWORD", "WECOM_WEBHOOK_URL", "TRIGGER_CONFIG", "SCHEDULES"].includes(target.token_secret)) return null;
    const token = env[target.token_secret];
    return typeof token === "string" && /^[A-Za-z0-9_]{10,255}$/.test(token) ? token : null;
}
