import { inspectConfig, parseConfig, tokenFor } from "./config.mjs";
import { wecomState } from "./wecom.mjs";
import { adminState, adminGate, loginState } from "./admin.mjs";
import { adminShell } from "./admin-ui.mjs";

export function configurationStatus(env = {}) {
    const config = inspectConfig(env.TRIGGER_CONFIG, env);
    config.items = config.items.map(item => ({ ...item, token_state: item.token_secret === null ? null
        : tokenFor(item, env) ? "configured" : env[item.token_secret] === undefined ? "missing" : "invalid" }));
    const status = {
        mode: "read_only", time_zone: "Asia/Shanghai",
        config,
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

function tokenPage(env) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRouter - 仓库管理</title>
<style>body{margin:0;background:radial-gradient(ellipse at 80% 0%,#cce8eb,transparent 55%),#eef6f7;color:#17383f;font:16px/1.7 "Microsoft YaHei","PingFang SC",sans-serif} [hidden]{display:none!important}
.access{max-width:460px;margin:80px auto;padding:28px;background:#fff;border:1px solid #cbdcdf;border-radius:10px}.access h1{font:28px "Songti SC",SimSun,serif}.access input{display:block;box-sizing:border-box;width:100%;padding:12px;margin:10px 0 16px;border:1px solid #8ba9af;border-radius:5px;font:inherit}.access button{padding:10px 18px;border:0;border-radius:5px;background:#164e59;color:#fff;font:inherit}.access small{display:block;color:#536d74}.access :focus-visible{outline:3px solid #087579;outline-offset:3px}@media(max-width:520px){.access{margin:30px 16px;padding:22px}}</style></head><body>
<section class="access" data-public-view><h1>仓库管理</h1><p>使用管理员用户名和密码登录。</p>
<form data-access-form><label for="access-user">用户名</label><input id="access-user" type="text" data-access-username autocomplete="off" spellcheck="false" required maxlength="64"><label for="access-secret">密码</label><input id="access-secret" type="password" data-access-input autocomplete="off" required minlength="12" maxlength="256"><button type="submit" data-access-submit>登录管理</button></form>
<p data-access-feedback role="status" aria-live="polite">${loginState(env) === "configured" ? "正在检查现有会话；登录与刷新不会提交签到任务。" : "登录配置缺失或不合法，请在 Cloudflare 配置 ADMIN_USERNAME 和 ADMIN_PASSWORD 后保存部署。"}</p><small>用户名和密码仅用于 HTTPS 登录，提交后立即清除；安全 Cookie 会话固定 12 小时，刷新可恢复。隐藏入口不是登录密码。</small><noscript>需要启用 JavaScript 才能加载管理页面。</noscript></section>
${adminShell()}<script src="/admin/client.js"></script></body></html>`;
}

export async function statusResponse(request, env) {
    const path = new URL(request.url).pathname;
    const entry = adminState(env) === "configured" && path === `/${env.DEBUG_ACCESS_TOKEN}`;
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    if (!["/", "/health"].includes(path) && !entry) return new Response(null, { status: 404, headers });
    if (path === "/health") {
        const denied = await adminGate(request, env);
        if (denied) return denied;
    }
    if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    if (entry) headers["Content-Security-Policy"] += "; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'";
    headers["Content-Type"] = path === "/" ? "text/plain; charset=utf-8" : path === "/health" ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
    const body = request.method === "HEAD" ? null : path === "/" ? "hello world"
        : path === "/health" ? JSON.stringify(configurationStatus(env)) : tokenPage(env);
    return new Response(body, { headers });
}
