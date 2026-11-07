import { parseConfig, tokenFor } from "./config.mjs";
import { adminClient } from "./admin-ui.mjs";

const ACCESS = /^[A-Za-z0-9_-]{32,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function adminState(env = {}) {
    const token = env.DEBUG_ACCESS_TOKEN;
    if (token === undefined || token === "") return "disabled";
    return typeof token === "string" && ACCESS.test(token) && !/\s/.test(token) ? "configured" : "invalid";
}

export async function authorized(request, env) {
    if (adminState(env) !== "configured") return false;
    const header = request.headers.get("Authorization");
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? "");
    if (!match) return false;
    const bytes = new TextEncoder();
    const [actual, expected] = await Promise.all([match[1], env.DEBUG_ACCESS_TOKEN]
        .map((token) => crypto.subtle.digest("SHA-256", bytes.encode(token))));
    return crypto.subtle.timingSafeEqual(actual, expected);
}

export function adminJson(value, status = 200) {
    return Response.json(value, { status, headers: { "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } });
}

export async function adminGate(request, env) {
    if (adminState(env) !== "configured") return adminJson({ status: "NOT_FOUND" }, 404);
    if (!await authorized(request, env)) return adminJson({ status: "UNAUTHORIZED" }, 401);
    return null;
}

export async function mutationBody(request, action) {
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== new URL(request.url).origin) return adminJson({ status: "ORIGIN_REJECTED" }, 403);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? ""))
        return adminJson({ status: "JSON_REQUIRED" }, 415);
    const reader = request.body?.getReader();
    if (!reader) return adminJson({ status: "BODY_INVALID" }, 400);
    const bytes = new Uint8Array(1024);
    let size = 0;
    let body;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (size + value.byteLength > bytes.length) {
                void reader.cancel().catch(() => {});
                return adminJson({ status: "BODY_TOO_LARGE" }, 413);
            }
            bytes.set(value, size);
            size += value.byteLength;
        }
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } catch { return adminJson({ status: "BODY_INVALID" }, 400); }
    finally { reader.releaseLock(); }
    const fields = { enabled: "enabled", run: "request_id", "logs/delete": "log_id", "logs/clear": null };
    const field = fields[action];
    const valid = body && typeof body === "object" && !Array.isArray(body)
        && Object.keys(body).length === (field === null ? 0 : 1)
        && (field === null || Object.hasOwn(body, field)
            && (field === "enabled" ? typeof body[field] === "boolean"
                : typeof body[field] === "string" && body[field].length === 36 && UUID.test(body[field])));
    return valid ? body : adminJson({ status: "BODY_INVALID" }, 400);
}

export function targetState(target, env) {
    return { id: target.id, repository: target.repository, workflow: target.workflow, ref: target.ref,
        enabled: target.enabled, token_state: tokenFor(target, env) ? "configured"
            : env[target.token_secret] === undefined || env[target.token_secret] === "" ? "missing" : "invalid",
        next_run: null, history: [], error: null };
}

export async function adminResponse(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin/client.js") {
        if (adminState(env) !== "configured") return adminJson({ status: "NOT_FOUND" }, 404);
        const headers = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
        if (!["GET", "HEAD"].includes(request.method))
            return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
        return new Response(request.method === "HEAD" ? null : `(${adminClient.toString()})();`, { headers });
    }
    if (url.pathname !== "/api/admin" && !url.pathname.startsWith("/api/admin/")) return null;
    const denied = await adminGate(request, env);
    if (denied) return denied;
    const listing = request.method === "GET" && url.pathname === "/api/admin/targets";
    const match = /^\/api\/admin\/targets\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(enabled|run|logs\/delete|logs\/clear)$/.exec(url.pathname);
    if (!listing && (request.method !== "POST" || !match)) return adminJson({ status: "NOT_FOUND" }, 404);
    let body;
    if (!listing) {
        body = await mutationBody(request, match[2]);
        if (body instanceof Response) return body;
    }
    let targets;
    try { targets = parseConfig(env.TRIGGER_CONFIG); }
    catch { return adminJson({ status: "CONFIG_INVALID" }, 503); }
    const target = listing ? null : targets.find((item) => item.id === match[1]);
    if (!listing && !target) return adminJson({ status: "TARGET_NOT_FOUND" }, 404);
    const objectRequest = async (item, action, payload) => {
        const stub = env.SCHEDULES.get(env.SCHEDULES.idFromName(`v1:${item.id}`));
        return stub.fetch(new Request(`https://scheduler.internal/admin/${action}?id=${item.id}`, {
            method: action === "state" ? "GET" : "POST",
            headers: { Authorization: `Bearer ${env.DEBUG_ACCESS_TOKEN}`,
                ...(action === "state" ? {} : { "Content-Type": "application/json" }) },
            ...(action === "state" ? {} : { body: JSON.stringify(payload) }),
        }));
    };
    if (listing) {
        const states = await Promise.all(targets.map(async (item) => {
            try {
                const response = await objectRequest(item, "state");
                if (!response.ok) throw new Error("STORAGE_UNAVAILABLE");
                return await response.json();
            } catch { return { ...targetState(item, env), error: "STORAGE_UNAVAILABLE" }; }
        }));
        return adminJson({ status: "OK", targets: states });
    }
    try {
        const response = await objectRequest(target, match[2], body);
        return adminJson(await response.json(), response.status);
    } catch { return adminJson({ status: "STORAGE_UNAVAILABLE" }, 503); }
}
