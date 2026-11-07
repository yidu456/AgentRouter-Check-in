export function adminShell() {
    return `<section id="trigger-admin" data-admin-panel hidden aria-label="签到调度管理">
<style>
#trigger-admin{--ar-page:#f6fafb;--ar-panel:#fff;--ar-rail:#e8f2f4;--ar-ink:#17383f;--ar-muted:#536d74;--ar-line:#cbdcdf;--ar-teal:#087579;--ar-danger:#a13e33;--ar-warn:#81511a;color:var(--ar-ink);font:14px/1.6 "Segoe UI Variable Text","Microsoft YaHei","PingFang SC",sans-serif;max-width:1160px;margin:36px auto;padding:0 20px;min-width:0}
[hidden]{display:none!important}#trigger-admin *{box-sizing:border-box}#trigger-admin h1,#trigger-admin h2,#trigger-admin h3,#trigger-admin p{margin:0}#trigger-admin button,#trigger-admin input{font:inherit}#trigger-admin button,#trigger-admin summary{cursor:pointer}#trigger-admin :focus-visible{outline:3px solid var(--ar-teal);outline-offset:4px}#trigger-admin code{font:12px/1.65 "Cascadia Code",Consolas,monospace;overflow-wrap:anywhere}
#trigger-admin .ar-shell{display:grid;grid-template-columns:158px minmax(0,1fr);background:var(--ar-page);border:1px solid var(--ar-line);border-radius:12px;overflow:clip}#trigger-admin .ar-sidebar{background:var(--ar-rail);padding:28px 16px;display:flex;flex-direction:column;gap:30px;border-right:1px solid var(--ar-line)}#trigger-admin .ar-brand{display:flex;align-items:center;gap:9px;font-weight:650}#trigger-admin .ar-monogram{display:grid;place-items:center;width:30px;height:30px;background:#164e59;color:white;border-radius:7px;font:16px "Baskerville",serif}#trigger-admin .ar-brand small{display:block;font-size:11px;font-weight:400;color:var(--ar-muted)}#trigger-admin .ar-nav{display:grid;gap:8px}#trigger-admin .ar-nav button{border:0;background:transparent;color:var(--ar-muted);text-align:left;padding:10px 12px;border-radius:6px}#trigger-admin .ar-nav button[aria-pressed=true]{background:var(--ar-panel);color:var(--ar-ink);box-shadow:inset 3px 0 var(--ar-teal)}#trigger-admin .ar-sidebar-footer{margin-top:auto;color:var(--ar-muted);font-size:12px;display:grid;gap:4px}
#trigger-admin .ar-content{padding:28px 26px;min-width:0;background:radial-gradient(ellipse at 100% 0%,var(--ar-rail),transparent 44%),var(--ar-page)}#trigger-admin .ar-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px;border:0;padding:0}#trigger-admin h1{font:600 28px/1.4 "Noto Serif SC","Songti SC","SimSun",serif;letter-spacing:1px}#trigger-admin .ar-sub{font-size:12px;color:var(--ar-muted);margin-top:5px}#trigger-admin .ar-notice{font-size:12px;color:var(--ar-muted);padding:14px 0 20px;border-top:1px solid var(--ar-line)}#trigger-admin .ar-section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}#trigger-admin h2{font-size:16px}#trigger-admin .ar-target-count{font-size:12px;color:var(--ar-muted)}#trigger-admin .ar-targets{display:grid;gap:14px}#trigger-admin .ar-target{background:var(--ar-panel);border:1px solid var(--ar-line);border-radius:8px;overflow:clip}#trigger-admin .ar-target-main{padding:18px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px}#trigger-admin .ar-repo-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#trigger-admin h3{font-size:14px;font-weight:600;overflow-wrap:anywhere}#trigger-admin .ar-state{font-size:11px;padding:1px 7px;border-radius:4px;color:var(--ar-teal);background:#e0f2ef}#trigger-admin .ar-state.paused{color:var(--ar-muted);background:var(--ar-rail)}#trigger-admin .ar-state.warning{color:var(--ar-warn);background:#fff3df}#trigger-admin .ar-metadata{display:flex;flex-wrap:wrap;gap:5px 12px;margin:7px 0 12px;font-size:11px;color:var(--ar-muted)}#trigger-admin .ar-next{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}#trigger-admin .ar-next-label{font-size:12px;color:var(--ar-muted)}#trigger-admin .ar-next-time{font-size:19px;font-variant-numeric:tabular-nums}#trigger-admin .ar-next-time.paused{font-size:14px;color:var(--ar-muted)}#trigger-admin .ar-last{font-size:11px;color:var(--ar-muted);margin-top:5px}#trigger-admin .ar-target-actions{display:flex;flex-direction:column;align-items:flex-end;gap:14px;min-width:103px}
#trigger-admin .ar-switch-label{display:flex;align-items:center;gap:8px;color:var(--ar-muted);font-size:12px;min-height:32px}#trigger-admin .ar-switch-input{appearance:none;width:32px;height:18px;background:var(--ar-line);border:0;border-radius:12px;position:relative;margin:0;flex-shrink:0}#trigger-admin .ar-switch-input:before{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;background:white;border-radius:50%}#trigger-admin .ar-switch-input:checked{background:var(--ar-teal)}#trigger-admin .ar-switch-input:checked:before{transform:translateX(14px)}#trigger-admin .ar-switch-input:disabled{opacity:.5}#trigger-admin .ar-button{display:inline-flex;justify-content:center;align-items:center;border:1px solid var(--ar-line);background:var(--ar-panel);color:var(--ar-ink);padding:6px 11px;border-radius:5px;white-space:nowrap;font-size:12px;min-height:32px}#trigger-admin .ar-button.primary{background:#164e59;border-color:#164e59;color:white}#trigger-admin .ar-button.quiet{border:0;background:transparent;padding:4px 7px}#trigger-admin .ar-button.danger{color:var(--ar-danger)}#trigger-admin .ar-button:disabled{color:var(--ar-muted);background:var(--ar-rail);opacity:.65;cursor:not-allowed}
#trigger-admin .ar-logs{border-top:1px solid var(--ar-line);background:var(--ar-page)}#trigger-admin .ar-logs summary{font-size:12px;color:var(--ar-muted);padding:10px 18px}#trigger-admin .ar-log-content{padding:0 18px 12px}#trigger-admin .ar-log-toolbar{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:11px;color:var(--ar-muted)}#trigger-admin .ar-log-row{display:grid;grid-template-columns:145px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--ar-line);font-size:12px}#trigger-admin .ar-log-time{font-size:11px;color:var(--ar-muted);font-variant-numeric:tabular-nums}#trigger-admin .ar-log-time span{display:block}#trigger-admin .ar-log-status.accepted{color:var(--ar-teal)}#trigger-admin .ar-log-status.rejected{color:var(--ar-danger)}#trigger-admin .ar-log-status.unknown{color:var(--ar-warn)}#trigger-admin .ar-log-detail{font-size:11px;color:var(--ar-muted);margin-top:2px}#trigger-admin .ar-empty{padding:13px 0;font-size:12px;color:var(--ar-muted)}#trigger-admin .ar-feedback{min-height:24px;margin-top:14px;font-size:12px;overflow-wrap:anywhere;color:var(--ar-teal)}#trigger-admin .ar-bottom{margin-top:20px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 20px;font-size:11px;color:var(--ar-muted)}
#trigger-admin .ar-dialog{border:1px solid var(--ar-line);border-radius:12px;background:white;color:var(--ar-ink);padding:24px;width:min(420px,calc(100% - 32px));box-shadow:0 18px 65px #0003;margin:auto}#trigger-admin .ar-dialog::backdrop{background:#10232c80}#trigger-admin .ar-dialog h2{font-size:19px;margin-bottom:10px}#trigger-admin .ar-dialog p{font-size:13px;color:var(--ar-muted);margin-bottom:8px;overflow-wrap:anywhere}#trigger-admin .ar-dialog-target{display:block;padding:10px 12px;background:var(--ar-rail);border-radius:6px;margin:12px 0 16px}#trigger-admin .ar-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
@media(max-width:780px){#trigger-admin{margin:0;padding:0}#trigger-admin .ar-shell{grid-template-columns:1fr;border-radius:0}#trigger-admin .ar-sidebar{padding:13px 18px;flex-direction:row;align-items:center;justify-content:space-between;gap:12px;border-right:0;border-bottom:1px solid var(--ar-line)}#trigger-admin .ar-sidebar-footer{display:none}#trigger-admin .ar-nav{display:flex;gap:4px}#trigger-admin .ar-nav button{padding:7px 10px}#trigger-admin .ar-nav button[aria-pressed=true]{box-shadow:inset 0 -2px var(--ar-teal)}#trigger-admin .ar-content{padding:22px 20px}}
@media(max-width:480px){#trigger-admin .ar-brand small{display:none}#trigger-admin .ar-brand{font-size:12px}#trigger-admin .ar-monogram{width:25px;height:25px}#trigger-admin .ar-sidebar{padding:12px;flex-wrap:wrap;gap:8px}#trigger-admin .ar-nav{margin-left:auto}#trigger-admin .ar-nav button{font-size:12px}#trigger-admin .ar-content{padding:20px 14px}#trigger-admin h1{font-size:24px}#trigger-admin .ar-top{flex-wrap:wrap;gap:10px}#trigger-admin .ar-target-main{grid-template-columns:1fr;padding:16px 14px;gap:12px}#trigger-admin .ar-target-actions{flex-direction:row;justify-content:space-between;align-items:center}#trigger-admin .ar-button,#trigger-admin .ar-switch-label,#trigger-admin .ar-logs summary{min-height:44px}#trigger-admin .ar-log-content{padding:0 14px 12px}#trigger-admin .ar-log-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}#trigger-admin .ar-log-time{grid-column:1;display:flex;gap:8px;flex-wrap:wrap}#trigger-admin .ar-log-body{grid-column:1}#trigger-admin .ar-log-row>button{grid-column:2;grid-row:1/span 2}#trigger-admin .ar-next-time{font-size:17px}#trigger-admin .ar-next-time.paused{font-size:14px}#trigger-admin .ar-section-heading{flex-wrap:wrap}}
</style>
<div class="ar-shell"><aside class="ar-sidebar" aria-label="页面导航"><div class="ar-brand"><span class="ar-monogram" aria-hidden="true">AR</span><div>AgentRouter<small>Cloudflare 调度</small></div></div><nav class="ar-nav" aria-label="查看方式"><button type="button" data-view="admin" aria-pressed="true">仓库管理</button><button type="button" data-view="public" aria-pressed="false">公开状态</button><button type="button" data-action="logout">退出管理</button></nav><div class="ar-sidebar-footer"><span>独立日期 · 独立随机</span><span>每天 01:00–23:00</span><span>Asia/Shanghai</span></div></aside>
<div class="ar-content"><header class="ar-top"><div><h1>仓库管理</h1><p class="ar-sub">管理员视图 · 访问 Token 已验证</p></div><button type="button" class="ar-button" data-action="refresh">刷新状态</button></header><p class="ar-notice">这里只记录触发结果。GitHub 已受理不等于签到成功，最终汇总仍由 Actions 发送。刷新仅读取，不补发任务或修复日程。</p><div class="ar-section-heading"><h2>运行目标</h2><span class="ar-target-count" data-target-count></span></div><div class="ar-targets" data-targets></div><p class="ar-feedback" role="status" aria-live="polite" data-feedback></p><footer class="ar-bottom"><span>日志最多 20 条 · 删除不改变日程或防重复记录</span><span>北京时间 UTC+8</span></footer></div></div>
<dialog class="ar-dialog" aria-labelledby="ar-dialog-title" data-confirm-dialog><h2 id="ar-dialog-title" data-dialog-title></h2><code class="ar-dialog-target" data-dialog-target></code><p data-dialog-message></p><p data-dialog-note></p><div class="ar-dialog-actions"><button type="button" class="ar-button" data-cancel>取消</button><button type="button" class="ar-button primary" data-confirm>确认</button></div></dialog></section>`;
}

export function adminClient() {
    function consumeToken() {
        const value = new URLSearchParams(location.hash.slice(1)).get("token");
        if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
        return value === null ? null : /^[A-Za-z0-9_-]{32,128}$/.test(value) && !/\s/.test(value) ? value : "";
    }
    let token = consumeToken() ?? "";
    const root = document.querySelector("#trigger-admin");
    if (!root) { token = ""; return; }
    const publicView = document.querySelector("[data-public-view]");
    const accessFeedback = document.querySelector("[data-access-feedback]");
    const returnAdmin = document.querySelector("[data-return-admin]");
    const list = root.querySelector("[data-targets]");
    const feedback = root.querySelector("[data-feedback]");
    const dialog = root.querySelector("[data-confirm-dialog]");
    const refreshButton = root.querySelector('[data-action="refresh"]');
    const errors = {
        UNAUTHORIZED: "访问 Token 验证失败或已失效。请重新打开原管理链接。",
        NOT_FOUND: "管理入口不可用，请检查访问配置并重新打开管理链接。",
        TARGET_NOT_FOUND: "目标已移除，请刷新状态。", LOG_NOT_FOUND: "日志已移除，请刷新状态。",
        ORIGIN_REJECTED: "请求来源不允许。请在同一管理页面操作。",
        BODY_INVALID: "操作数据不合法，请刷新页面后重试。", BODY_TOO_LARGE: "操作数据超出大小限制。",
        JSON_REQUIRED: "操作需要 JSON 数据，请重新打开页面。",
        TARGET_DISABLED: "目标已关闭，不能运行。请刷新状态。",
        TOKEN_MISSING: "GitHub Token 未配置或格式不合法，不能运行。",
        REQUEST_CONFLICT: "本次请求对应的目标配置已改变，不能重试。",
        COOLDOWN: "手动运行间隔至少 30 秒，请稍后操作。",
        RECEIPTS_FULL: "防重复请求记录已满，请等待 24 小时内的旧记录过期。",
        CONFIG_INVALID: "目标配置不合法，请在 Cloudflare 修正并发布。",
        STATE_INVALID: "目标存储状态不合法，已停用管理操作。",
        STORAGE_UNAVAILABLE: "存储暂不可用，请稍后刷新。",
        TRANSPORT_UNKNOWN: "未收到完整响应，操作结果未知。不会自动重试。",
        RESPONSE_INVALID: "服务返回的状态不可识别，请刷新状态。",
    };
    const notifications = {
        NOTIFY_UNKNOWN: "企业微信结果未知，不自动重试",
        NOTIFY_ACCEPTED: "企业微信已受理", NOTIFY_FAILED: "企业微信通知失败",
        NOTIFY_NOT_CONFIGURED: "企业微信未配置", NOTIFY_CONFIG_INVALID: "企业微信配置不合法",
    };
    let targets = [];
    let verified = false;
    let busy = false;
    let session = 0;
    let pending = null;
    const expanded = new Set();
    const uncertain = new Map();
    const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric",
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const dateText = (value) => dateFormat.format(new Date(value));
    const resultText = (code) => code === "DISPATCH_ACCEPTED" ? "GitHub 已受理，不等于签到成功"
        : /^DISPATCH_HTTP_[1-5][0-9]{2}$/.test(code) ? `GitHub 拒绝请求（HTTP ${code.slice(-3)}）`
        : "触发结果未知，不自动重试";
    const knownResult = (code) => code === "DISPATCH_ACCEPTED" || code === "DISPATCH_UNKNOWN"
        || /^DISPATCH_HTTP_[1-5][0-9]{2}$/.test(code);
    const uuid = (value) => typeof value === "string" && value.length === 36
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    const validRecord = (record) => record && uuid(record.id) && Number.isFinite(record.at)
        && record.at >= 0 && record.at <= 8640000000000000
        && ["automatic", "manual"].includes(record.source) && knownResult(record.result)
        && Object.hasOwn(notifications, record.notification);
    const validTarget = (target) => target && typeof target.id === "string"
        && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.id)
        && [target.repository, target.workflow, target.ref].every((value) => typeof value === "string" && value.length <= 512)
        && typeof target.enabled === "boolean" && ["configured", "missing", "invalid"].includes(target.token_state)
        && [null, "STATE_INVALID", "STORAGE_UNAVAILABLE"].includes(target.error)
        && (target.next_run === null || typeof target.next_run === "string" && Number.isFinite(Date.parse(target.next_run)))
        && Array.isArray(target.history) && target.history.length <= 20 && target.history.every(validRecord);

    function element(tag, className, text) {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    }
    function button(text, action, handler, disabled = false, className = "") {
        const item = element("button", "ar-button " + className, text);
        item.type = "button";
        item.dataset.action = action;
        item.disabled = disabled;
        item.addEventListener("click", handler);
        return item;
    }
    function announce(message) {
        (verified ? feedback : accessFeedback).textContent = message;
    }
    function logout(message = "已退出管理。访问 Token 已从本页内存清除；需重新打开原链接进入。") {
        session++;
        token = "";
        verified = false;
        busy = false;
        targets = [];
        pending = null;
        expanded.clear();
        uncertain.clear();
        list.replaceChildren();
        root.querySelector("[data-target-count]").textContent = "";
        feedback.textContent = "";
        for (const selector of ["[data-dialog-title]", "[data-dialog-target]", "[data-dialog-message]", "[data-dialog-note]"])
            root.querySelector(selector).textContent = "";
        dialog.close();
        root.hidden = true;
        publicView.hidden = false;
        returnAdmin.hidden = true;
        announce(message);
    }
    async function request(path, body) {
        const current = session;
        let response;
        let data;
        try {
            response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
                credentials: "omit", redirect: "error", headers: { Authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (current !== session) throw new Error("SESSION_ENDED");
            if (response.status === 401) {
                logout(errors.UNAUTHORIZED);
                throw new Error("SESSION_ENDED");
            }
            data = await response.json();
        } catch { throw new Error(current === session ? "TRANSPORT_UNKNOWN" : "SESSION_ENDED"); }
        if (current !== session) throw new Error("SESSION_ENDED");
        if (response.status === 401 || data?.status === "UNAUTHORIZED" || data?.status === "NOT_FOUND") {
            logout(errors[data?.status] ?? errors.UNAUTHORIZED);
            throw new Error("SESSION_ENDED");
        }
        if (!response.ok) throw new Error(Object.hasOwn(errors, data?.status) ? data.status : "RESPONSE_INVALID");
        return data;
    }
    function render() {
        const cards = targets.map((target) => {
            const blocked = busy || Boolean(target.error);
            const runnable = target.enabled && target.token_state === "configured" && !target.error;
            const tone = target.error || target.token_state !== "configured" ? "warning" : !target.enabled ? "paused" : "";
            const article = element("article", "ar-target");
            article.dataset.targetId = target.id;
            article.setAttribute("aria-label", target.repository);
            const main = element("div", "ar-target-main");
            const description = element("div");
            const heading = element("div", "ar-repo-line");
            heading.append(element("h3", "", target.repository), element("span", "ar-state " + tone,
                target.error ? "状态不可用" : !target.enabled ? "已关闭" : target.token_state === "configured" ? "已开启" : "Token 不可用"));
            const metadata = element("div", "ar-metadata");
            for (const [label, value] of [["工作流", target.workflow], ["分支", target.ref], ["Token",
                { configured: "已配置（权限未验证）", missing: "未配置", invalid: "格式不合法" }[target.token_state]]]) {
                const field = element("span", "", label + " ");
                field.append(element("code", "", value));
                metadata.append(field);
            }
            const next = element("div", "ar-next");
            const time = element("time", "ar-next-time " + (runnable && target.next_run ? "" : "paused"),
                target.error ? "状态不可用" : !target.enabled ? "已暂停" : target.token_state !== "configured"
                    ? "等待配置 GitHub Token" : target.next_run ? dateText(target.next_run) : "暂无已保存的未来日程");
            time.dataset.next = "";
            if (runnable && target.next_run) time.dateTime = target.next_run;
            next.append(element("span", "ar-next-label", "下次运行"), time);
            description.append(heading, metadata, next, element("p", "ar-last", target.error ? errors[target.error]
                : !target.enabled ? "自动和手动触发均已关闭，已提交的运行不受影响"
                : target.token_state !== "configured" ? "在 Cloudflare 补充 GitHub Token 后才能触发"
                : "数据库中的已保存日程 · 手动运行不改变此时间"));
            const actions = element("div", "ar-target-actions");
            const label = element("label", "ar-switch-label", "允许运行");
            const toggle = element("input", "ar-switch-input");
            toggle.type = "checkbox";
            toggle.dataset.action = "toggle";
            toggle.checked = target.enabled;
            toggle.disabled = blocked;
            toggle.setAttribute("aria-label", target.repository + " 允许运行");
            toggle.addEventListener("change", () => mutate("enabled", target, { enabled: toggle.checked }));
            label.append(toggle);
            actions.append(label, button(uncertain.has(target.id) ? "重试原请求" : "手动运行", "run",
                () => confirm("run", target), blocked || !runnable, "primary"));
            main.append(description, actions);
            const logs = element("details", "ar-logs");
            logs.open = expanded.has(target.id);
            logs.addEventListener("toggle", () => { if (logs.open) expanded.add(target.id); else expanded.delete(target.id); });
            logs.append(element("summary", "", `最近调度记录 (${target.history.length})`));
            const content = element("div", "ar-log-content");
            const toolbar = element("div", "ar-log-toolbar");
            toolbar.append(element("span", "", "仅保留最近 20 条"), button("清空该仓库日志", "clear",
                () => confirm("clear", target), blocked || !target.history.length, "quiet danger"));
            content.append(toolbar);
            for (const record of target.history) {
                const row = element("div", "ar-log-row");
                row.dataset.log = record.id;
                const at = element("div", "ar-log-time");
                at.append(element("span", "", dateText(record.at)), element("span", "", record.source === "manual" ? "手动触发" : "自动触发"));
                const body = element("div", "ar-log-body");
                body.append(element("div", "ar-log-status " + (record.result === "DISPATCH_ACCEPTED" ? "accepted"
                    : record.result === "DISPATCH_UNKNOWN" ? "unknown" : "rejected"), resultText(record.result)),
                element("div", "ar-log-detail", notifications[record.notification]));
                const remove = button("删除", "delete", () => confirm("delete", target, record.id), blocked, "quiet danger");
                remove.dataset.logId = record.id;
                remove.setAttribute("aria-label", "删除 " + dateText(record.at) + " 的日志");
                row.append(at, body, remove);
                content.append(row);
            }
            if (!target.history.length) content.append(element("p", "ar-empty", target.error ? "暂不能读取记录" : "暂无调度记录"));
            logs.append(content);
            article.append(main, logs);
            return article;
        });
        if (!targets.length) cards.push(element("p", "ar-empty", "暂无配置目标。请在 Cloudflare 添加目标并发布。"));
        list.replaceChildren(...cards);
        root.querySelector("[data-target-count]").textContent = `${targets.length} 个目标 · ${targets.filter((target) => target.enabled && !target.error).length} 个开启`;
        refreshButton.disabled = busy;
    }
    async function refresh(announceSuccess = true) {
        if (!token || busy) return;
        const current = session;
        busy = true;
        refreshButton.disabled = true;
        if (verified) render();
        try {
            const data = await request("/api/admin/targets");
            if (data?.status !== "OK" || !Array.isArray(data.targets) || data.targets.length > 100
                || !data.targets.every(validTarget) || new Set(data.targets.map((target) => target.id)).size !== data.targets.length)
                throw new Error("RESPONSE_INVALID");
            targets = data.targets;
            verified = true;
            root.hidden = false;
            publicView.hidden = true;
            returnAdmin.hidden = true;
            accessFeedback.textContent = "";
            if (announceSuccess) announce("已刷新实际开关、已保存日程和最近记录。未触发运行或修改日程。");
        } catch (error) {
            if (current === session && error.message !== "SESSION_ENDED") announce(errors[error.message] ?? errors.RESPONSE_INVALID);
        } finally {
            if (current === session) { busy = false; if (verified) render(); else refreshButton.disabled = false; }
        }
    }
    function confirm(action, target, logId) {
        if (busy || !verified || target.error) return;
        pending = { action, target, logId };
        root.querySelector("[data-dialog-title]").textContent = action === "run" ? "确认手动运行？"
            : action === "clear" ? "清空这个仓库的日志？" : "删除这条调度日志？";
        root.querySelector("[data-dialog-target]").textContent = target.repository + " / " + target.ref;
        root.querySelector("[data-dialog-message]").textContent = action === "run"
            ? uncertain.has(target.id) ? "上次响应未知。只重试原请求 ID，查询或完成同一请求，不创建新运行。"
                : "将向 GitHub 提交一次手动触发，不改变下一次自动运行时间。"
            : action === "clear" ? `将删除该目标管理页中的 ${target.history.length} 条记录。` : "只删除管理页中的这一条记录。";
        root.querySelector("[data-dialog-note]").textContent = action === "run"
            ? "GitHub 已受理不等于签到成功；通知单独显示，不自动重试。"
            : "不删除日程、开关、防重复请求记录或 Cloudflare / GitHub 平台日志。";
        const confirmButton = root.querySelector("[data-confirm]");
        confirmButton.textContent = action === "run" ? uncertain.has(target.id) ? "重试原请求" : "确认运行"
            : action === "clear" ? "确认清空" : "确认删除";
        confirmButton.className = "ar-button " + (action === "run" ? "primary" : "danger");
        dialog.showModal();
    }
    async function mutate(action, target, body) {
        if (!token || !verified || busy || target.error) return;
        const current = session;
        busy = true;
        render();
        let message = "";
        try {
            const path = action === "delete" ? "logs/delete" : action === "clear" ? "logs/clear" : action;
            const data = await request(`/api/admin/targets/${encodeURIComponent(target.id)}/${path}`, body);
            if (action === "enabled") {
                if (data?.status !== "ENABLED_UPDATED" || !validTarget(data.target) || data.target.id !== target.id)
                    throw new Error("RESPONSE_INVALID");
                targets = targets.map((item) => item.id === target.id ? data.target : item);
                message = `${target.repository} 已${data.target.enabled ? "开启" : "关闭"}，数据库开关已保存。`;
            } else if (action === "run") {
                if (!knownResult(data?.status) || typeof data.cached !== "boolean" || !validRecord(data.record)
                    || data.record.id.toLowerCase() !== body.request_id.toLowerCase() || data.record.result !== data.status)
                    throw new Error("TRANSPORT_UNKNOWN");
                uncertain.delete(target.id);
                expanded.add(target.id);
                message = `${data.cached ? "原请求结果：" : "手动触发："}${resultText(data.status)}。${notifications[data.record.notification]}。下一次自动日程不变。`;
            } else {
                if (data?.status !== (action === "clear" ? "HISTORY_CLEARED" : "HISTORY_DELETED")) throw new Error("RESPONSE_INVALID");
                target.history = action === "clear" ? [] : target.history.filter((record) => record.id !== body.log_id);
                message = action === "clear" ? "已清空该仓库日志，日程与防重复记录保持不变。" : "已删除一条调度日志，日程与防重复记录保持不变。";
            }
        } catch (error) {
            if (current !== session || error.message === "SESSION_ENDED") return;
            // Storage/unknown responses can follow a sent dispatch; only explicit pre-attempt rejection permits a new ID.
            const rejectedBeforeDispatch = ["BODY_INVALID", "BODY_TOO_LARGE", "JSON_REQUIRED", "ORIGIN_REJECTED",
                "TARGET_NOT_FOUND", "CONFIG_INVALID", "TARGET_DISABLED", "TOKEN_MISSING", "REQUEST_CONFLICT", "COOLDOWN", "RECEIPTS_FULL"];
            if (action === "run" && !rejectedBeforeDispatch.includes(error.message)) {
                uncertain.set(target.id, body.request_id);
                message = (errors[error.message] ?? errors.RESPONSE_INVALID)
                    + " 本次运行是否提交尚未确定。可点击“重试原请求”，仅使用同一请求 ID。";
            } else {
                if (action === "run") uncertain.delete(target.id);
                message = errors[error.message] ?? errors.RESPONSE_INVALID;
            }
        } finally {
            if (current === session) { busy = false; render(); }
        }
        if (current !== session) return;
        // Read back receipts/history instead of recreating a cached record that was deleted.
        if (action === "run" && !uncertain.has(target.id)) await refresh(false);
        if (current === session && verified) announce(message);
    }
    root.querySelector('[data-action="logout"]').addEventListener("click", () => logout());
    refreshButton.addEventListener("click", () => refresh());
    root.querySelector('[data-view="public"]').addEventListener("click", () => {
        if (!verified) return;
        root.hidden = true;
        publicView.hidden = false;
        returnAdmin.hidden = false;
        accessFeedback.textContent = "公开状态只显示配置默认值，不读取数据库开关。管理 Token 仍在本页内存，可返回管理或退出。";
    });
    returnAdmin.addEventListener("click", () => {
        if (!verified) return;
        root.hidden = false;
        publicView.hidden = true;
        returnAdmin.hidden = true;
    });
    root.querySelector("[data-cancel]").addEventListener("click", () => { pending = null; dialog.close(); });
    dialog.addEventListener("cancel", () => { pending = null; });
    root.querySelector("[data-confirm]").addEventListener("click", () => {
        if (!pending || busy) return;
        const { action, target, logId } = pending;
        pending = null;
        dialog.close();
        if (action === "run" && (!target.enabled || target.token_state !== "configured" || target.error)) return;
        let body = action === "clear" ? {} : { log_id: logId };
        if (action === "run") {
            if (typeof crypto.randomUUID !== "function") { announce("浏览器不支持安全请求 ID，请使用现代浏览器的 HTTPS 管理页面。"); return; }
            body = { request_id: uncertain.get(target.id) ?? crypto.randomUUID() };
        }
        void mutate(action, target, body);
    });
    addEventListener("pagehide", () => logout("管理会话已清除，请重新打开原链接。"));
    addEventListener("hashchange", () => {
        const nextToken = consumeToken();
        if (nextToken === null) return;
        logout("正在验证访问 Token…");
        token = nextToken;
        if (token) void refresh();
        else announce(errors.UNAUTHORIZED);
    });
    if (token) void refresh();
}
