import { parseConfig, tokenFor } from "./config.mjs";
import { wecomState } from "./wecom.mjs";
import { adminState } from "./admin.mjs";
import { adminShell } from "./admin-ui.mjs";

const DIAGNOSTICS = {
    JSON_TYPE: "TRIGGER_CONFIG 必须设置为 Text / Plaintext 类型的 JSON 文本。",
    JSON_SYNTAX: "JSON 无法解析，请检查双引号、逗号与括号；不支持注释或末尾逗号。",
    CONFIG_SIZE: "配置超出大小限制，请减少目标数量。",
    CONFIG_FIELDS: "顶层只接受 version 和 targets，不能缺少字段或添加其他字段。",
    CONFIG_VERSION: "version 必须是数字 1。",
    TARGETS_INVALID: "targets 必须是数组，最多 100 个目标；空数组表示停用全部目标。",
    TARGET_FIELDS: "目标必须包含 id、repository、workflow、ref、token_secret、enabled，且不能添加未知字段。",
    TARGET_FIELD: "该字段的类型或格式不合法，请按部署指南修正。",
    DUPLICATE_ID: "目标 id 重复，请使用唯一、稳定的 id。",
    DUPLICATE_TARGET: "仓库、工作流、分支组合重复，不能重复调度同一个目标。",
};

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

function escape(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function page(status, administration) {
    const error = status.config.error;
    const message = error ? `${error.field}：${DIAGNOSTICS[error.code] ?? "配置不合法，请查看部署指南。"}`
        : status.config.state === "missing" ? "尚未配置 TRIGGER_CONFIG。先添加 Plaintext 变量，再按指南填写目标。"
        : "JSON 已解析，字段、目标唯一性与格式校验通过。";
    const scheduleLabels = {
        not_configured: "等待完成配置", disabled: "配置默认停用自动触发",
        needs_binding: "存储绑定尚未配置", needs_tokens: "启用目标的 Token 尚未配置完整",
        enabled_unverified: "配置默认启用自动触发 · 权限未验证",
    };
    const tone = status.config.state === "invalid" || ["needs_binding", "needs_tokens"].includes(status.schedule.state)
        ? "attention" : status.schedule.state === "enabled_unverified" ? "ready" : "idle";
    const tokenText = status.config.state !== "valid" ? "等待合法目标配置后检查"
        : `已配置 ${status.github_tokens.configured} / 未配置 ${status.github_tokens.missing} / 格式不合法 ${status.github_tokens.invalid}`;
    const botText = { missing: "未配置 · 可选", invalid: "Webhook 格式不合法", configured: "已配置 · 未验证送达" }[status.wecom.state];
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRouter · 部署检查</title>
<style>
:root{--ink:#17383f;--muted:#526e74;--paper:#eef6f7;--line:#bdd0d4;--accent:#087979;--warning:#a24330}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:radial-gradient(ellipse at 80% 0%,#cce8eb 0,transparent 55%),var(--paper);font:17px/1.7 "Baskerville","Noto Serif SC","Songti SC",serif}
main{max-width:980px;padding:60px 32px 30px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:2px solid var(--ink);padding-bottom:18px}
header span{font:14px "Cascadia Code",Consolas,monospace;color:var(--muted)}a{color:var(--accent);text-underline-offset:4px}h1{font-size:clamp(30px,5vw,50px);margin:0}h2{font-size:24px;margin:0 0 10px}
.banner{border-left:6px solid var(--line);padding:24px 28px;margin:30px 0;background:#ffffff8c}.banner.ready{border-color:var(--accent)}.banner.attention{border-color:var(--warning)}.banner p{margin:6px 0;color:var(--muted)}
dl{margin:0}dl>div{display:grid;grid-template-columns:180px 1fr;gap:22px;padding:20px 4px;border-bottom:1px solid var(--line)}dt{font-weight:700}dd{margin:0}small{display:block;color:var(--muted);font-size:14px;line-height:1.6}
.error{color:var(--warning)}.notes{margin:30px 0;padding:22px;border-radius:18px 0 18px 0;background:#dcecee}p{max-width:76ch}footer{display:flex;gap:18px;flex-wrap:wrap;font-size:14px;color:var(--muted)}.refresh{display:inline-block;padding:8px 15px;background:var(--ink);color:white;text-decoration:none;border-radius:6px}a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
@media(max-width:580px){main{padding:24px 20px}header{align-items:flex-start;flex-direction:column;gap:8px}.banner{padding:18px}dl>div{grid-template-columns:1fr;gap:6px;padding:16px 0}footer{gap:12px}}
</style></head><body><main data-public-view><header><h1>部署检查</h1><span>AgentRouter / Cloudflare trigger</span></header>
<section class="banner ${tone}" aria-label="配置概况"><h2>${escape(scheduleLabels[status.schedule.state])}</h2><p>浏览器访问只读取本地配置，不登录、不触发 GitHub，也不发送机器人通知。</p><a class="refresh" href="/">刷新配置检查</a></section>
<dl><div><dt>JSON 配置</dt><dd class="${error ? "error" : ""}">${escape(message)}</dd></div>
<div><dt>GitHub Token</dt><dd>${escape(tokenText)}<small>“已配置”仅表示 Secret 存在且格式通过；尚未验证 GitHub 权限、有效期或可用性。</small></dd></div>
<div><dt>自动触发</dt><dd>JSON 配置默认：目标 ${status.targets.total} 个，其中启用 ${status.targets.enabled} 个<small>数据库开关可覆盖配置默认值，本页不读取实际开关、日程或历史。北京时间每天 00:05 初始化；各目标、各日期在 01:00–23:00 独立随机。</small></dd></div>
<div><dt>企业微信通知</dt><dd>${escape(botText)}<small>只报告调度结果。GitHub 已受理不等于签到成功，最终签到汇总仍由 GitHub 发送。</small></dd></div>
<div><dt>日程存储</dt><dd>${status.storage_binding.configured ? "SCHEDULES 绑定已配置" : "SCHEDULES 绑定未配置"}<small>绑定存在不代表已初始化日程；详细执行情况请在 Cloudflare 日志和 GitHub Actions 核对。</small></dd></div></dl>
<aside class="notes"><strong>配置修改后记得发布</strong><p>在 Cloudflare 的 Settings → Variables &amp; Secrets 保存并 Deploy。这里不展示仓库、Secret 名称、密钥原值或完整 JSON。重新部署不等于停用；开启前确认旧定时入口不会重复运行。</p></aside>
${administration ? '<p data-access-feedback role="status" aria-live="polite">管理访问已配置。使用带访问 Token 片段的链接打开；访问 Token 仅保存在本页内存，刷新后需重新打开原链接。</p><button type="button" data-return-admin hidden>返回仓库管理</button>' : ""}
<footer><a href="/health">查看只读 JSON 状态</a><a href="https://github.com/yidu456/AgentRouter-Check-in/blob/main/cloudflare/README.md" rel="noreferrer">部署指南</a><a href="https://github.com/yidu456/AgentRouter-Check-in/blob/main/cloudflare/API-TOKENS.md" rel="noreferrer">Token 指南</a></footer></main>${administration ? adminShell() + '<script src="/admin/client.js"></script>' : ""}</body></html>`;
}

export function statusResponse(request, env) {
    const path = new URL(request.url).pathname;
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    if (path !== "/" && path !== "/health") return new Response(null, { status: 404, headers });
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    }
    const status = configurationStatus(env);
    const administration = path === "/" && adminState(env) === "configured";
    if (administration) headers["Content-Security-Policy"] += "; script-src 'self'; connect-src 'self'";
    headers["Content-Type"] = path === "/health" ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
    const body = request.method === "HEAD" ? null : path === "/health" ? JSON.stringify(status) : page(status, administration);
    return new Response(body, { headers });
}
