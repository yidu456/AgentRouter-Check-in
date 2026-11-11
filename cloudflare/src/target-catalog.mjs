import { parseConfig, targetBinding, tokenFor, RESERVED_SECRETS } from "./config.mjs";

const KEY = "target_catalog";
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const revision = value => Number.isSafeInteger(value) && value >= 0;

function invalid(field, code = "TARGET_FIELD") {
    const error = new Error("TARGET_INVALID");
    error.diagnostic = { field, code };
    throw error;
}

export function normalizeCatalogTarget(value, id = value?.id) {
    const keys = ["name", "repository", "workflow", "ref", "token_secret", "enabled"];
    if (Object.hasOwn(value ?? {}, "id")) keys.push("id");
    if (Object.hasOwn(value ?? {}, "schedule")) keys.push("schedule");
    if (!exact(value, keys)) invalid("target", "TARGET_FIELDS");
    if (typeof value.name !== "string" || value.name.trim() !== value.name || !value.name.length
        || value.name.length > 64 || /[\x00-\x1f\x7f]/.test(value.name)) invalid("target.name");
    if (RESERVED_SECRETS.includes(value.token_secret)) invalid("target.token_secret");
    const { name, ...target } = value;
    try { return { ...parseConfig(JSON.stringify({ version: 1, targets: [{ ...target, id }] }))[0], name }; }
    catch (error) { invalid(error.diagnostic?.field.replace("targets[0]", "target") ?? "target",
        error.diagnostic?.code ?? "TARGET_FIELD"); }
}

function validCatalog(value) {
    if (!exact(value, ["version", "revision", "items"]) || value.version !== 1 || !revision(value.revision)
        || !Array.isArray(value.items) || value.items.length > 100 || JSON.stringify(value).length > 128_000) return false;
    const ids = new Set(), bindings = new Set();
    try {
        for (const item of value.items) {
            if (!Object.hasOwn(item ?? {}, "catalog_revision") || !revision(item.catalog_revision)
                || item.catalog_revision > value.revision || !revision(item.control_revision) || item.control_revision > value.revision) return false;
            const { catalog_revision, control_revision, ...source } = item;
            const target = normalizeCatalogTarget(source);
            if (ids.has(target.id) || bindings.has(targetBinding(target))) return false;
            ids.add(target.id); bindings.add(targetBinding(target));
        }
        return true;
    } catch { return false; }
}

export async function storedCatalog(storage) {
    const value = await storage.get(KEY);
    if (value === undefined) return null;
    if (!validCatalog(value)) throw new Error("STATE_INVALID");
    return value;
}

export const catalogStub = env => env.SCHEDULES.get(env.SCHEDULES.idFromName("catalog:v1"));

export async function readCatalog(env) {
    if (!env.SCHEDULES) return null;
    let response, value;
    try {
        response = await catalogStub(env).fetch(new Request("https://scheduler.internal/catalog/read"));
        if (!response.ok) throw new Error("STATE_INVALID");
        value = await response.json();
    } catch (error) { throw new Error(error?.message === "STATE_INVALID" ? "STATE_INVALID" : "STORAGE_UNAVAILABLE"); }
    if (value === null) return null;
    if (!validCatalog(value)) throw new Error("STATE_INVALID");
    return value;
}

export async function resolveTargets(env) {
    const catalog = await readCatalog(env);
    return catalog ? catalog.items : parseConfig(env.TRIGGER_CONFIG);
}

export function credentialNames(env, catalog) {
    const names = new Set(Object.keys(env).filter(key => key.length <= 64 && /^GITHUB_TOKEN(?:_[A-Z0-9_]+)?$/.test(key)));
    // Retain imported reference names; never enumerate arbitrary Worker Secrets.
    for (const item of catalog.items) names.add(item.token_secret);
    return [...names].filter(token_secret => tokenFor({ token_secret }, env)).sort();
}

export function publicCatalog(catalog, env) {
    return { status: "OK", version: 1, revision: catalog.revision,
        items: catalog.items.map(({ catalog_revision, control_revision, ...item }) => item), credentials: credentialNames(env, catalog) };
}

export async function bootstrapCatalog(storage, env) {
    let catalog = await storedCatalog(storage);
    if (!catalog) {
        const items = parseConfig(env.TRIGGER_CONFIG).map((target, index) => {
            if (RESERVED_SECRETS.includes(target.token_secret)) throw Object.assign(new Error("CONFIG_INVALID"), {
                diagnostic: { field: `targets[${index}].token_secret`, code: "TARGET_FIELD" } });
            return { ...target, name: target.id, catalog_revision: 0, control_revision: 0 };
        });
        catalog = { version: 1, revision: 0, items };
        await storage.put(KEY, catalog);
    }
    return catalog;
}

export async function saveCatalog(storage, env, body) {
    const catalog = await storedCatalog(storage);
    if (!catalog) throw new Error("CATALOG_NOT_INITIALIZED");
    if (body.revision !== catalog.revision) throw new Error("CATALOG_CONFLICT");
    if (catalog.revision === Number.MAX_SAFE_INTEGER) throw new Error("CATALOG_REVISION_LIMIT");
    const target = normalizeCatalogTarget(body.target, body.target.id ?? "t_" + crypto.randomUUID().replaceAll("-", ""));
    const index = catalog.items.findIndex(item => item.id === target.id);
    if (body.target.id !== undefined && index === -1) throw new Error("TARGET_NOT_FOUND");
    if (index === -1 && catalog.items.length >= 100) throw new Error("CATALOG_FULL");
    if (!credentialNames(env, catalog).includes(target.token_secret)) throw new Error("CREDENTIAL_INVALID");
    if (catalog.items.some(item => item.id !== target.id && targetBinding(item) === targetBinding(target)))
        invalid("target.repository", "DUPLICATE_TARGET");
    const next = catalog.revision + 1;
    const item = { ...target, catalog_revision: next, control_revision: next };
    if (index === -1) catalog.items.push(item); else catalog.items[index] = item;
    catalog.revision = next;
    if (!validCatalog(catalog)) invalid("catalog", "CONFIG_SIZE");
    await storage.put(KEY, catalog);
    return { status: "CATALOG_UPDATED", revision: next, target };
}

export async function enableCatalogTarget(storage, env, id, enabled) {
    const catalog = await storedCatalog(storage);
    const item = catalog?.items.find(target => target.id === id);
    if (!item) throw new Error("TARGET_NOT_FOUND");
    if (catalog.revision === Number.MAX_SAFE_INTEGER) throw new Error("CATALOG_REVISION_LIMIT");
    // Patch only control; a stale full editor cannot overwrite this change under the old catalog revision.
    item.enabled = enabled;
    item.control_revision = ++catalog.revision;
    await storage.put(KEY, catalog);
    return { status: "ENABLED_UPDATED" };
}
