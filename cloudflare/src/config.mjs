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
        if (!exactKeys(target, TARGET_KEYS)) invalid(field, "TARGET_FIELDS");
        const checks = {
            id: typeof target.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.id),
            repository: typeof target.repository === "string"
                && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(target.repository),
            workflow: typeof target.workflow === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(target.workflow),
            ref: typeof target.ref === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target.ref)
                && !/\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(target.ref),
            token_secret: typeof target.token_secret === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(target.token_secret),
            enabled: typeof target.enabled === "boolean",
        };
        for (const [key, valid] of Object.entries(checks)) if (!valid) invalid(`${field}.${key}`, "TARGET_FIELD");
        const binding = targetBinding(target);
        if (ids.has(target.id)) invalid(`${field}.id`, "DUPLICATE_ID");
        if (bindings.has(binding)) invalid(`${field}.repository`, "DUPLICATE_TARGET");
        ids.add(target.id);
        bindings.add(binding);
    }
    return config.targets;
}

export function tokenFor(target, env) {
    if (["DEBUG_ACCESS_TOKEN", "ADMIN_USERNAME", "ADMIN_PASSWORD", "WECOM_WEBHOOK_URL", "TRIGGER_CONFIG", "SCHEDULES"].includes(target.token_secret)) return null;
    const token = env[target.token_secret];
    return typeof token === "string" && /^[A-Za-z0-9_]{10,255}$/.test(token) ? token : null;
}
