import { parseConfig, tokenFor } from "./config.mjs";
import { wecomState } from "./wecom.mjs";
import { adminState, adminGate } from "./admin.mjs";
import { adminShell } from "./admin-ui.mjs";

export function configurationStatus(env = {}) {
    const status = {
        mode: "read_only", time_zone: "Asia/Shanghai",
        config: { state: env.TRIGGER_CONFIG === undefined ? "missing" : "valid", error: null },
        targets: { total: 0, enabled: 0 },
        github_tokens: { configured: 0, missing: 0, invalid: 0, verified: false },
        wecom: { state: wecomState(env), verified: false },
        storage_binding: { configured: Boolean(env.SCHEDULES) },
        schedule: { state: "not_configured", window: "01:00–23:00", initialize_at: "00:05", plan_read: false },
    };
    let targets;
    try { targets = parseConfig(env.TRIGGER_CONFIG); }
    catch (error) {
        status.config.state = "invalid";
        status.config.error = error.diagnostic ?? { field: "config", code: "CONFIG_FIELDS" };
        return status;
    }
    status.targets.total = targets.length;
    let enabledReady = 0;
    for (const target of targets) {
        const valid = Boolean(tokenFor(target, env));
        if (valid) status.github_tokens.configured++;
        else if (env[target.token_secret] === undefined) status.github_tokens.missing++;
        else status.github_tokens.invalid++;
        if (target.enabled) {
            status.targets.enabled++;
            if (valid) enabledReady++;
        }
    }
    if (status.config.state === "missing") return status;
    status.schedule.state = status.targets.enabled === 0 ? "disabled"
        : !status.storage_binding.configured ? "needs_binding"
        : enabledReady < status.targets.enabled ? "needs_tokens" : "enabled_unverified";
    return status;
}

function tokenPage() {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRouter - 仓库管理</title>
<style>body{margin:0;background:radial-gradient(ellipse at 80% 0%,#cce8eb,transparent 55%),#eef6f7;color:#17383f;font:16px/1.7 "Microsoft YaHei","PingFang SC",sans-serif} [hidden]{display:none!important}
.access{max-width:460px;margin:80px auto;padding:28px;background:#fff;border:1px solid #cbdcdf;border-radius:10px}.access h1{font:28px "Songti SC",SimSun,serif}.access input{display:block;box-sizing:border-box;width:100%;padding:12px;margin:10px 0 16px;border:1px solid #8ba9af;border-radius:5px;font:inherit}.access button{padding:10px 18px;border:0;border-radius:5px;background:#164e59;color:#fff;font:inherit}.access small{display:block;color:#536d74}.access :focus-visible{outline:3px solid #087579;outline-offset:3px}@media(max-width:520px){.access{margin:30px 16px;padding:22px}}</style></head><body>
<section class="access" data-public-view><h1>仓库管理</h1><p>请输入独立的管理访问 Token。</p>
<form data-access-form><label for="access-token">访问 Token</label><input id="access-token" type="password" data-access-input autocomplete="off" spellcheck="false" required maxlength="128"><button type="submit" data-access-submit>进入管理</button></form>
<p data-access-feedback role="status" aria-live="polite">仅验证访问权限，不会运行签到。</p><small>Token 仅保存在本页内存，不写入浏览器存储。</small><noscript>需要启用 JavaScript 才能加载管理页面。</noscript></section>
${adminShell()}<script src="/admin/client.js"></script></body></html>`;
}

export async function statusResponse(request, env) {
    const path = new URL(request.url).pathname;
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    if (!["/", "/token", "/health"].includes(path)) return new Response(null, { status: 404, headers });
    if (path === "/token" && adminState(env) !== "configured") return new Response(null, { status: 404, headers });
    if (path === "/health") {
        const denied = await adminGate(request, env);
        if (denied) return denied;
    }
    if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    if (path === "/token") headers["Content-Security-Policy"] += "; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'";
    headers["Content-Type"] = path === "/" ? "text/plain; charset=utf-8" : path === "/health" ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
    const body = request.method === "HEAD" ? null : path === "/" ? "hello world"
        : path === "/health" ? JSON.stringify(configurationStatus(env)) : tokenPage();
    return new Response(body, { headers });
}
