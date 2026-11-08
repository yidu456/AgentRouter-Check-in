const COOKIE = "__Host-ar_session";
const LIFETIME = 12 * 60 * 60 * 1000;
const KEY_STORAGE = "session_key";
const RECORD_STORAGE = "sessions";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

class InvalidState extends Error {
    constructor() { super("STATE_INVALID"); }
}

class ProtocolRejected extends Error {}

function json(value, status = 200, cookie) {
    return Response.json(value, { status, headers: { "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        ...(cookie === undefined ? {} : { "Set-Cookie": cookie }) } });
}

function encode(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value) {
    if (typeof value !== "string" || !TOKEN.test(value)) return null;
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="), (char) => char.charCodeAt(0));
    return bytes.length === 32 && encode(bytes) === value ? bytes : null;
}

function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validExpiry(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

function cookieSession(request) {
    if (new URL(request.url).protocol !== "https:") return null;
    const header = request.headers.get("Cookie");
    if (!header || header.length > 4096) return null;
    const cookies = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return null;
    const raw = cookies[0].slice(COOKIE.length + 1);
    if (raw.length > 160) return null;
    const match = /^v1\.([A-Za-z0-9_-]{43})\.([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/.exec(raw);
    if (!match || !decode(match[1]) || !decode(match[3])) return null;
    const expires = Number(match[2]);
    // Rejecting an untrusted expiry is safe; no access is granted before MAC and record checks.
    if (!validExpiry(expires) || expires <= Date.now() || expires > Date.now() + LIFETIME) return null;
    return { raw, nonce: match[1], expires, signature: match[3] };
}

function sameOrigin(request) {
    const url = new URL(request.url);
    return url.protocol === "https:" && request.headers.get("Origin") === url.origin;
}

function jsonMedia(request) {
    return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "");
}

async function boundedJson(source) {
    const reader = source.body?.getReader();
    if (!reader) return json({ status: "BODY_INVALID" }, 400);
    const bytes = new Uint8Array(1024);
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (size + value.byteLength > bytes.length) {
                void reader.cancel().catch(() => {});
                return json({ status: "BODY_TOO_LARGE" }, 413);
            }
            bytes.set(value, size);
            size += value.byteLength;
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } catch { return json({ status: "BODY_INVALID" }, 400); }
    finally { reader.releaseLock(); }
}

async function emptyBody(request) {
    if (!sameOrigin(request)) return json({ status: "ORIGIN_REJECTED" }, 403);
    if (!jsonMedia(request)) return json({ status: "JSON_REQUIRED" }, 415);
    const body = await boundedJson(request);
    if (body instanceof Response) return body;
    return exactKeys(body, []) ? null : json({ status: "BODY_INVALID" }, 400);
}

async function state(storage) {
    const [meta, records] = await Promise.all([storage.get(KEY_STORAGE), storage.get(RECORD_STORAGE)]);
    if (meta !== undefined && (!exactKeys(meta, ["version", "key"]) || meta.version !== 1 || !decode(meta.key)))
        throw new InvalidState();
    if (records !== undefined && (!exactKeys(records, ["version", "items"]) || records.version !== 1
            || !Array.isArray(records.items) || records.items.length > 128
            || ![...records.items].every((item) => exactKeys(item, ["hash", "expires_at"]) && decode(item.hash) && validExpiry(item.expires_at))
            || new Set(records.items.map((item) => item.hash)).size !== records.items.length))
        throw new InvalidState();
    if (!meta && records !== undefined) throw new InvalidState();
    return { meta, records: records ?? { version: 1, items: [] } };
}

async function importKey(meta) {
    return crypto.subtle.importKey("raw", decode(meta.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function mac(key, value) {
    return encode(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(value))));
}

async function context(request, env, key) {
    const identity = await mac(key, ["ar-session-identity-v1", env.ADMIN_USERNAME, env.ADMIN_PASSWORD, env.DEBUG_ACCESS_TOKEN]);
    return [new URL(request.url).host, identity];
}

function signatureInput(session, binding) {
    return ["ar-session-cookie-v1", ...binding, "v1", session.nonce, session.expires];
}

async function hash(session) {
    return encode(await crypto.subtle.digest("SHA-256", encoder.encode(session.raw)));
}

async function authenticated(request, env, current, session) {
    if (!current.meta || session.expires <= Date.now()) return null;
    const key = await importKey(current.meta);
    const binding = await context(request, env, key);
    if (!await crypto.subtle.verify("HMAC", key, decode(session.signature), encoder.encode(JSON.stringify(signatureInput(session, binding)))))
        return null;
    const digest = await hash(session);
    if (!current.records.items.some((item) => item.hash === digest && item.expires_at === session.expires)) return null;
    const csrf = await mac(key, ["ar-session-csrf-v1", ...binding, session.nonce, session.expires]);
    if (!["GET", "HEAD"].includes(request.method)) {
        if (!sameOrigin(request)) return json({ status: "ORIGIN_REJECTED" }, 403);
        if (!jsonMedia(request)) return json({ status: "JSON_REQUIRED" }, 415);
        const actual = request.headers.get("X-CSRF-Token");
        if (!decode(actual) || !await crypto.subtle.verify("HMAC", key, decode(actual),
            encoder.encode(JSON.stringify(["ar-session-csrf-v1", ...binding, session.nonce, session.expires]))))
            return json({ status: "CSRF_REJECTED" }, 403);
    }
    return session.expires > Date.now() ? { hash: digest, csrf } : null;
}

function authenticatedJson(session, csrf, cookie) {
    return json({ status: "AUTHENTICATED", expires_at: new Date(session.expires).toISOString(), csrf_token: csrf }, 200, cookie);
}

function setCookie(value, expires) {
    return `${COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value ? LIFETIME / 1000 : 0}`
        + `; Expires=${new Date(expires).toUTCString()}`;
}

async function login(request, env, storage, current) {
    const now = Date.now();
    current.records.items = current.records.items.filter((item) => item.expires_at > now);
    if (current.records.items.length >= 128) return json({ status: "SESSION_LIMIT" }, 429);
    if (!current.meta) {
        current.meta = { version: 1, key: encode(crypto.getRandomValues(new Uint8Array(32))) };
        // Persist the private key first so an issued session can survive an object restart.
        await storage.put(KEY_STORAGE, current.meta);
    }
    const key = await importKey(current.meta);
    const binding = await context(request, env, key);
    const session = { nonce: encode(crypto.getRandomValues(new Uint8Array(32))), expires: now + LIFETIME };
    const signature = await mac(key, signatureInput(session, binding));
    session.raw = `v1.${session.nonce}.${session.expires}.${signature}`;
    current.records.items.push({ hash: await hash(session), expires_at: session.expires });
    await storage.put(RECORD_STORAGE, current.records);
    const csrf = await mac(key, ["ar-session-csrf-v1", ...binding, session.nonce, session.expires]);
    return authenticatedJson(session, csrf, setCookie(session.raw, session.expires));
}

export async function sessionStorageResponse(request, ctx, env, basicAuthorized) {
    const path = new URL(request.url).pathname;
    if (!["/session/login", "/session/check", "/session/logout"].includes(path)) return null;
    const checking = path === "/session/check";
    const loggingIn = path === "/session/login";
    if (!(checking ? ["GET", "POST"].includes(request.method) : request.method === "POST"))
        return json({ status: "NOT_FOUND" }, 404);
    if (loggingIn && !await basicAuthorized(request, env)) return json({ status: "UNAUTHORIZED" }, 401);
    const session = loggingIn ? null : cookieSession(request);
    if (!loggingIn && !session) return json({ status: "UNAUTHORIZED" }, 401);
    if (!checking) {
        const denied = await emptyBody(request);
        if (denied) return denied;
    }
    try {
        return await ctx.blockConcurrencyWhile(async () => {
            const current = await state(ctx.storage);
            if (loggingIn) return login(request, env, ctx.storage, current);
            const auth = await authenticated(request, env, current, session);
            if (!auth) return json({ status: "UNAUTHORIZED" }, 401);
            if (auth instanceof Response) return auth;
            if (checking) return authenticatedJson(session, auth.csrf);
            current.records.items = current.records.items.filter((item) => item.hash !== auth.hash);
            await ctx.storage.put(RECORD_STORAGE, current.records);
            return json({ status: "SIGNED_OUT" }, 200, setCookie("", 0));
        });
    } catch (error) {
        return json({ status: error instanceof InvalidState ? "STATE_INVALID" : "STORAGE_UNAVAILABLE" }, 503);
    }
}

async function objectRequest(request, env, action, method, body) {
    const url = new URL(request.url);
    url.pathname = `/session/${action}`;
    url.search = "";
    url.hash = "";
    const headers = new Headers();
    for (const name of ["Cookie", "Origin", "X-CSRF-Token", "Content-Type", ...(action === "login" ? ["Authorization"] : [])]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
    }
    const stub = env.SCHEDULES.get(env.SCHEDULES.idFromName("auth:v1"));
    const response = await stub.fetch(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }));
    const value = await boundedJson(response);
    if (response.status === 200 && action === "logout" && exactKeys(value, ["status"]) && value.status === "SIGNED_OUT")
        return json(value, 200, setCookie("", 0));
    if (response.status === 200 && action !== "logout" && exactKeys(value, ["status", "expires_at", "csrf_token"])
            && value.status === "AUTHENTICATED" && decode(value.csrf_token) && typeof value.expires_at === "string"
            && value.expires_at.length === 24 && validExpiry(Date.parse(value.expires_at))
            && new Date(value.expires_at).toISOString() === value.expires_at) {
        let cookie;
        if (action === "login") {
            const header = response.headers.get("Set-Cookie");
            if (!header || header.length > 256) throw new Error("STORAGE_UNAVAILABLE");
            const session = cookieSession(new Request(request.url, { headers: { Cookie: header.split(";", 1)[0] } }));
            if (!session || new Date(session.expires).toISOString() !== value.expires_at) throw new Error("STORAGE_UNAVAILABLE");
            cookie = setCookie(session.raw, session.expires);
        }
        return json(value, 200, cookie);
    }
    const errors = { UNAUTHORIZED: 401, ORIGIN_REJECTED: 403, CSRF_REJECTED: 403, JSON_REQUIRED: 415,
        BODY_INVALID: 400, BODY_TOO_LARGE: 413, SESSION_LIMIT: 429, STATE_INVALID: 503, STORAGE_UNAVAILABLE: 503, NOT_FOUND: 404 };
    if (exactKeys(value, ["status"]) && Object.hasOwn(errors, value.status) && response.status === errors[value.status])
        return json(value, response.status);
    throw new Error("STORAGE_UNAVAILABLE");
}

export async function sessionApiResponse(request, env, basicAuthorized) {
    const path = new URL(request.url).pathname;
    const actions = { "/api/admin/session": "check", "/api/admin/session/login": "login", "/api/admin/session/logout": "logout" };
    const action = actions[path];
    if (!action) return null;
    if (request.method !== (action === "check" ? "GET" : "POST")) return json({ status: "NOT_FOUND" }, 404);
    if (action === "login" && !await basicAuthorized(request, env)) return json({ status: "UNAUTHORIZED" }, 401);
    if (action !== "login" && !cookieSession(request)) return json({ status: "UNAUTHORIZED" }, 401);
    if (action !== "check") {
        const denied = await emptyBody(request);
        if (denied) return denied;
    }
    try { return await objectRequest(request, env, action, request.method, action === "check" ? undefined : "{}"); }
    catch { return json({ status: "STORAGE_UNAVAILABLE" }, 503); }
}

export async function sessionAuthorized(request, env) {
    const session = cookieSession(request);
    if (!session) return false;
    try {
        const response = await objectRequest(request, env, "check", ["GET", "HEAD"].includes(request.method) ? "GET" : "POST");
        if (response.status === 401) return false;
        const body = await response.json();
        if ([403, 415].includes(response.status)) throw new ProtocolRejected(body.status);
        if (response.status === 503 && body?.status === "STATE_INVALID") throw new InvalidState();
        if (response.status !== 200 || !exactKeys(body, ["status", "expires_at", "csrf_token"])
                || body.status !== "AUTHENTICATED" || !decode(body.csrf_token)
                || typeof body.expires_at !== "string" || body.expires_at !== new Date(session.expires).toISOString())
            throw new Error("STORAGE_UNAVAILABLE");
        return session.expires > Date.now();
    } catch (error) {
        if (error instanceof ProtocolRejected) throw new Error(error.message);
        throw new Error(error instanceof InvalidState ? "STATE_INVALID" : "STORAGE_UNAVAILABLE");
    }
}
