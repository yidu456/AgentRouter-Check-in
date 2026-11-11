export function adminShell() {
    return `<section id="trigger-admin" data-admin-panel hidden aria-label="签到调度管理">
<style>
#trigger-admin{--ar-page:#f6fafb;--ar-panel:#fff;--ar-rail:#e8f2f4;--ar-ink:#17383f;--ar-muted:#536d74;--ar-line:#cbdcdf;--ar-teal:#087579;--ar-danger:#a13e33;--ar-warn:#81511a;color:var(--ar-ink);font:14px/1.6 "Segoe UI Variable Text","Microsoft YaHei","PingFang SC",sans-serif;max-width:1160px;margin:36px auto;padding:0 20px;min-width:0}
[hidden]{display:none!important}#trigger-admin *{box-sizing:border-box}#trigger-admin h1,#trigger-admin h2,#trigger-admin h3,#trigger-admin p{margin:0}#trigger-admin button,#trigger-admin input,#trigger-admin select{font:inherit}#trigger-admin button,#trigger-admin summary{cursor:pointer}#trigger-admin :focus-visible{outline:3px solid var(--ar-teal);outline-offset:4px}#trigger-admin code{font:12px/1.65 "Cascadia Code",Consolas,monospace;overflow-wrap:anywhere}
#trigger-admin .ar-shell{display:grid;grid-template-columns:158px minmax(0,1fr);background:var(--ar-page);border:1px solid var(--ar-line);border-radius:12px;overflow:clip}#trigger-admin .ar-sidebar{background:var(--ar-rail);padding:28px 16px;display:flex;flex-direction:column;gap:30px;border-right:1px solid var(--ar-line)}#trigger-admin .ar-brand{display:flex;align-items:center;gap:9px;font-weight:650}#trigger-admin .ar-monogram{display:grid;place-items:center;width:30px;height:30px;background:#164e59;color:white;border-radius:7px;font:16px "Baskerville",serif}#trigger-admin .ar-brand small{display:block;font-size:11px;font-weight:400;color:var(--ar-muted)}#trigger-admin .ar-nav{display:grid;gap:8px}#trigger-admin .ar-nav button{border:0;background:transparent;color:var(--ar-muted);text-align:left;padding:10px 12px;border-radius:6px}#trigger-admin .ar-nav button[aria-pressed=true]{background:var(--ar-panel);color:var(--ar-ink);box-shadow:inset 3px 0 var(--ar-teal)}
#trigger-admin .ar-content{padding:28px 26px;min-width:0;background:radial-gradient(ellipse at 100% 0%,var(--ar-rail),transparent 44%),var(--ar-page)}#trigger-admin .ar-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px;border:0;padding:0}#trigger-admin h1{font:600 28px/1.4 "Noto Serif SC","Songti SC","SimSun",serif;letter-spacing:1px}#trigger-admin .ar-sub{font-size:12px;color:var(--ar-muted);margin-top:5px}#trigger-admin .ar-notice{font-size:12px;color:var(--ar-muted);padding:14px 0 20px;border-top:1px solid var(--ar-line)}#trigger-admin .ar-section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}#trigger-admin h2{font-size:16px}#trigger-admin .ar-target-count{font-size:12px;color:var(--ar-muted)}#trigger-admin .ar-targets{display:grid;gap:14px}#trigger-admin .ar-target{background:var(--ar-panel);border:1px solid var(--ar-line);border-radius:8px;overflow:clip}#trigger-admin .ar-target-main{padding:18px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px}#trigger-admin .ar-repo-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#trigger-admin h3{font-size:14px;font-weight:600;overflow-wrap:anywhere}#trigger-admin .ar-state{font-size:11px;padding:1px 7px;border-radius:4px;color:var(--ar-teal);background:#e0f2ef}#trigger-admin .ar-state.paused{color:var(--ar-muted);background:var(--ar-rail)}#trigger-admin .ar-state.warning{color:var(--ar-warn);background:#fff3df}#trigger-admin .ar-metadata{display:flex;flex-wrap:wrap;gap:5px 12px;margin:7px 0 12px;font-size:11px;color:var(--ar-muted)}#trigger-admin .ar-next{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}#trigger-admin .ar-next-label{font-size:12px;color:var(--ar-muted)}#trigger-admin .ar-next-time{font-size:19px;font-variant-numeric:tabular-nums}#trigger-admin .ar-next-time.paused{font-size:14px;color:var(--ar-muted)}#trigger-admin .ar-last{font-size:11px;color:var(--ar-muted);margin-top:5px}#trigger-admin .ar-target-actions{display:flex;flex-direction:column;align-items:flex-end;gap:14px;min-width:103px}
#trigger-admin .ar-switch-label{display:flex;align-items:center;gap:8px;color:var(--ar-muted);font-size:12px;min-height:32px}#trigger-admin .ar-switch-input{appearance:none;width:32px;height:18px;background:var(--ar-line);border:0;border-radius:12px;position:relative;margin:0;flex-shrink:0}#trigger-admin .ar-switch-input:before{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;background:white;border-radius:50%}#trigger-admin .ar-switch-input:checked{background:var(--ar-teal)}#trigger-admin .ar-switch-input:checked:before{transform:translateX(14px)}#trigger-admin .ar-switch-input:disabled{opacity:.5}#trigger-admin .ar-button{display:inline-flex;justify-content:center;align-items:center;border:1px solid var(--ar-line);background:var(--ar-panel);color:var(--ar-ink);padding:6px 11px;border-radius:5px;white-space:nowrap;font-size:12px;min-height:32px}#trigger-admin .ar-button.primary{background:#164e59;border-color:#164e59;color:white}#trigger-admin .ar-button.quiet{border:0;background:transparent;padding:4px 7px}#trigger-admin .ar-button.danger{color:var(--ar-danger)}#trigger-admin .ar-button:disabled{color:var(--ar-muted);background:var(--ar-rail);opacity:.65;cursor:not-allowed}
#trigger-admin .ar-logs{border-top:1px solid var(--ar-line);background:var(--ar-page)}#trigger-admin .ar-logs summary{font-size:12px;color:var(--ar-muted);padding:10px 18px}#trigger-admin .ar-log-content{padding:0 18px 12px}#trigger-admin .ar-log-toolbar{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:11px;color:var(--ar-muted)}#trigger-admin .ar-log-row{display:grid;grid-template-columns:145px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--ar-line);font-size:12px}#trigger-admin .ar-log-time{font-size:11px;color:var(--ar-muted);font-variant-numeric:tabular-nums}#trigger-admin .ar-log-time span{display:block}#trigger-admin .ar-log-status.accepted{color:var(--ar-teal)}#trigger-admin .ar-log-status.rejected{color:var(--ar-danger)}#trigger-admin .ar-log-status.unknown{color:var(--ar-warn)}#trigger-admin .ar-log-detail{font-size:11px;color:var(--ar-muted);margin-top:2px}#trigger-admin .ar-empty{padding:13px 0;font-size:12px;color:var(--ar-muted)}#trigger-admin .ar-feedback{min-height:24px;margin-top:14px;font-size:12px;overflow-wrap:anywhere;color:var(--ar-teal)}#trigger-admin .ar-bottom{margin-top:20px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 20px;font-size:11px;color:var(--ar-muted)}
#trigger-admin .ar-dialog{border:1px solid var(--ar-line);border-radius:12px;background:white;color:var(--ar-ink);padding:24px;width:min(420px,calc(100% - 32px));box-shadow:0 18px 65px #0003;margin:auto}#trigger-admin .ar-dialog::backdrop{background:#10232c80}#trigger-admin .ar-dialog h2{font-size:19px;margin-bottom:10px}#trigger-admin .ar-dialog p{font-size:13px;color:var(--ar-muted);margin-bottom:8px;overflow-wrap:anywhere}#trigger-admin .ar-dialog-target{display:block;padding:10px 12px;background:var(--ar-rail);border-radius:6px;margin:12px 0 16px}#trigger-admin .ar-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
#trigger-admin .ar-sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}#trigger-admin .ar-readiness{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}#trigger-admin .ar-readiness article{border-top:3px solid var(--ar-teal);background:var(--ar-panel);padding:14px 12px;min-width:0;border-radius:0 0 6px 6px}#trigger-admin .ar-readiness article.warning{border-color:var(--ar-warn)}#trigger-admin .ar-readiness article.invalid{border-color:var(--ar-danger)}#trigger-admin .ar-readiness h3{font-size:12px;color:var(--ar-muted);margin-bottom:6px}#trigger-admin .ar-check-state{font-size:16px;font-weight:600}#trigger-admin .ar-check-note{font-size:11px;color:var(--ar-muted);margin-top:6px}#trigger-admin .ar-config-table{width:100%;border-collapse:collapse;background:var(--ar-panel);font-size:12px;table-layout:fixed}#trigger-admin .ar-config-table caption{text-align:left;font-size:16px;font-weight:600;padding:12px 0}#trigger-admin .ar-config-table th,#trigger-admin .ar-config-table td{padding:12px 10px;border-bottom:1px solid var(--ar-line);text-align:left;vertical-align:top;overflow-wrap:anywhere}#trigger-admin .ar-config-table thead{background:var(--ar-rail)}#trigger-admin .ar-config-table th:first-child{width:24%}#trigger-admin .ar-config-table th:nth-child(2){width:18%}#trigger-admin .ar-config-table th:nth-child(3){width:12%}#trigger-admin .ar-config-table th:nth-child(4){width:24%}#trigger-admin .ar-config-error{background:#fff5ef;box-shadow:inset 3px 0 var(--ar-danger)}#trigger-admin .ar-field-error{display:block;color:var(--ar-danger);font-size:11px;margin-top:6px}#trigger-admin .ar-badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}#trigger-admin .ar-time-badge{display:inline-flex;gap:5px;align-items:center;border:1px solid var(--ar-line);border-radius:4px;padding:3px 6px;font-size:11px;background:var(--ar-page);font-variant-numeric:tabular-nums}#trigger-admin .ar-diagnostic{margin-top:16px;border:1px solid var(--ar-line);border-radius:6px;background:var(--ar-panel)}#trigger-admin .ar-diagnostic summary{padding:10px 12px;font-size:12px;color:var(--ar-muted)}#trigger-admin .ar-diagnostic pre{white-space:pre-wrap;margin:0;padding:0 12px 12px;overflow-wrap:anywhere}
#trigger-admin .ar-schedule{border-top:1px solid var(--ar-line);background:var(--ar-page)}#trigger-admin .ar-schedule summary{padding:12px 18px;font-size:12px;color:var(--ar-teal)}#trigger-admin .ar-schedule-form{padding:4px 18px 18px;display:grid;gap:12px}#trigger-admin .ar-schedule-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}#trigger-admin .ar-schedule-field{display:grid;gap:5px;font-size:12px;min-width:0}#trigger-admin .ar-schedule-field input,#trigger-admin .ar-schedule-field select{width:100%;min-width:0;min-height:38px;border:1px solid var(--ar-line);border-radius:5px;background:var(--ar-panel);color:var(--ar-ink);padding:6px 9px}#trigger-admin .ar-schedule-times{display:grid;gap:10px}#trigger-admin .ar-schedule-time{display:flex;align-items:end;gap:10px}#trigger-admin .ar-schedule-time label{flex:1}#trigger-admin .ar-schedule-actions{display:flex;flex-wrap:wrap;gap:8px}@media(max-width:480px){#trigger-admin .ar-schedule-fields{grid-template-columns:1fr}#trigger-admin .ar-schedule-form{padding:4px 14px 16px}#trigger-admin .ar-schedule summary,#trigger-admin .ar-schedule-field input,#trigger-admin .ar-schedule-field select{min-height:44px}}
#trigger-admin .ar-plan-table{width:100%;margin-top:16px;border-collapse:collapse;font-size:12px;table-layout:fixed}#trigger-admin .ar-plan-table caption{text-align:left;padding-bottom:7px}#trigger-admin .ar-plan-heading{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}#trigger-admin .ar-plan-heading span{font-weight:600}#trigger-admin .ar-plan-heading time{color:var(--ar-muted);font-variant-numeric:tabular-nums}#trigger-admin .ar-plan-table th,#trigger-admin .ar-plan-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--ar-line);overflow-wrap:anywhere}#trigger-admin .ar-plan-table th{color:var(--ar-muted);font-size:11px;font-weight:400;background:var(--ar-page)}#trigger-admin .ar-plan-table th:first-child{width:76px}#trigger-admin .ar-plan-table td:first-child{font-variant-numeric:tabular-nums}#trigger-admin .ar-plan-table .accepted{color:var(--ar-teal)}#trigger-admin .ar-plan-table .unknown{color:var(--ar-warn)}#trigger-admin .ar-plan-table .skipped{color:var(--ar-muted)}#trigger-admin .ar-run-details{margin-top:9px;font-size:11px;color:var(--ar-muted)}#trigger-admin .ar-run-details summary{padding:4px 0}#trigger-admin .ar-usage{max-width:720px;font-size:13px}#trigger-admin .ar-usage article{padding:18px 0;border-top:1px solid var(--ar-line)}#trigger-admin .ar-usage article:first-child{padding-top:0;border-top:0}#trigger-admin .ar-usage h2{margin-bottom:10px}#trigger-admin .ar-usage p{margin-top:9px;color:var(--ar-muted)}#trigger-admin .ar-usage ol{padding-left:22px;margin:0;color:var(--ar-muted)}#trigger-admin .ar-usage li+li{margin-top:8px}
@media(max-width:780px){#trigger-admin{margin:0;padding:0}#trigger-admin .ar-shell{grid-template-columns:1fr;border-radius:0}#trigger-admin .ar-sidebar{padding:13px 18px;flex-direction:row;align-items:center;justify-content:space-between;gap:12px;border-right:0;border-bottom:1px solid var(--ar-line)}#trigger-admin .ar-nav{display:flex;flex-wrap:wrap;gap:4px}#trigger-admin .ar-nav button{padding:7px 10px}#trigger-admin .ar-nav button[aria-pressed=true]{box-shadow:inset 0 -2px var(--ar-teal)}#trigger-admin .ar-content{padding:22px 20px}}
@media(max-width:480px){#trigger-admin .ar-brand small{display:none}#trigger-admin .ar-brand{font-size:12px}#trigger-admin .ar-monogram{width:25px;height:25px}#trigger-admin .ar-sidebar{padding:12px;flex-wrap:wrap;gap:8px}#trigger-admin .ar-nav{width:100%;margin-left:0;justify-content:space-between}#trigger-admin .ar-nav button{font-size:12px}#trigger-admin .ar-content{padding:20px 14px}#trigger-admin h1{font-size:24px}#trigger-admin .ar-top{flex-wrap:wrap;gap:10px}#trigger-admin .ar-target-main{grid-template-columns:1fr;padding:16px 14px;gap:12px}#trigger-admin .ar-target-actions{flex-direction:row;justify-content:space-between;align-items:center}#trigger-admin .ar-button,#trigger-admin .ar-switch-label,#trigger-admin .ar-logs summary{min-height:44px}#trigger-admin .ar-log-content{padding:0 14px 12px}#trigger-admin .ar-log-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}#trigger-admin .ar-log-time{grid-column:1;display:flex;gap:8px;flex-wrap:wrap}#trigger-admin .ar-log-body{grid-column:1}#trigger-admin .ar-log-row>button{grid-column:2;grid-row:1/span 2}#trigger-admin .ar-next-time{font-size:17px}#trigger-admin .ar-next-time.paused{font-size:14px}#trigger-admin .ar-section-heading{flex-wrap:wrap}}
@media(max-width:900px){#trigger-admin .ar-readiness{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){#trigger-admin .ar-config-table,#trigger-admin .ar-config-table caption,#trigger-admin .ar-config-table tbody,#trigger-admin .ar-config-table tr,#trigger-admin .ar-config-table td{display:block;width:100%}#trigger-admin .ar-config-table thead{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}#trigger-admin .ar-config-table tr{margin-bottom:12px;border:1px solid var(--ar-line);border-radius:6px;overflow:hidden}#trigger-admin .ar-config-table td{border:0;padding:8px 12px}#trigger-admin .ar-config-table td:before{content:attr(data-label);display:block;font-size:11px;color:var(--ar-muted)}#trigger-admin .ar-diagnostic summary{min-height:44px}}
#trigger-admin .ar-shell{display:block}#trigger-admin .ar-sidebar{padding:16px 26px;flex-direction:row;align-items:center;justify-content:space-between;gap:20px;border-right:0;border-bottom:1px solid var(--ar-line)}#trigger-admin .ar-nav{display:flex;flex-wrap:wrap;gap:5px}#trigger-admin .ar-nav button{padding:7px 10px}#trigger-admin .ar-nav button[aria-pressed=true]{box-shadow:inset 0 -2px var(--ar-teal);background:var(--ar-panel)}#trigger-admin .ar-brand small{display:none}
#trigger-admin .ar-section-tools{display:flex;align-items:center;gap:12px}#trigger-admin .ar-targets[data-targets]{gap:0;border:1px solid var(--ar-line);border-radius:7px;overflow:clip;background:var(--ar-panel)}#trigger-admin .ar-list-head,#trigger-admin .ar-target-main{display:grid;grid-template-columns:minmax(0,1fr) 142px 80px 145px;gap:16px;align-items:start}#trigger-admin .ar-list-head{padding:9px 16px;font-size:11px;color:var(--ar-muted)}#trigger-admin [data-targets] .ar-target{border:0;border-radius:0;border-bottom:1px solid var(--ar-line)}#trigger-admin [data-targets] .ar-target:last-child{border-bottom:0}#trigger-admin .ar-target-main{padding:16px}#trigger-admin .ar-repository{font-size:11px;color:var(--ar-muted);overflow-wrap:anywhere;margin-top:3px}#trigger-admin .ar-metadata{margin:5px 0;gap:3px 10px}#trigger-admin .ar-metadata code{font-size:11px}#trigger-admin .ar-next{display:block}#trigger-admin .ar-next-label{display:none}#trigger-admin .ar-next-time{display:block;font-size:17px;line-height:1.45}#trigger-admin .ar-next-time small{display:block;font-size:11px;color:var(--ar-muted)}#trigger-admin .ar-next-time.paused{font-size:12px}#trigger-admin .ar-state{margin-top:4px;background:none;padding:0;font-size:11px}#trigger-admin .ar-target-actions{min-width:0;display:flex;flex-direction:row;align-items:center;justify-content:flex-end;gap:4px;flex-wrap:wrap}#trigger-admin .ar-target-actions .ar-switch-label{width:100%;justify-content:flex-end;order:3;font-size:11px;min-height:24px}#trigger-admin .ar-card-feedback{font-size:11px;color:var(--ar-warn);padding:0 16px 9px}
#trigger-admin .ar-editor{width:min(540px,calc(100% - 28px));max-height:calc(100% - 28px);overflow:auto;padding:22px}#trigger-admin .ar-editor-head{display:flex;align-items:center;justify-content:space-between;gap:10px}#trigger-admin .ar-editor-context{margin:0 0 14px;font-size:12px;overflow-wrap:anywhere}#trigger-admin .ar-editor .ar-schedule{border:0;background:none}#trigger-admin .ar-editor .ar-schedule-form{padding:0}#trigger-admin .ar-editor-tabs{display:flex;gap:10px;border-bottom:1px solid var(--ar-line);padding-bottom:7px;margin-bottom:5px}#trigger-admin .ar-editor-tabs button[aria-pressed=true]{background:var(--ar-rail)}#trigger-admin .ar-editor-basic{display:grid;gap:12px}#trigger-admin .ar-editor .ar-schedule-actions{justify-content:flex-end;border-top:1px solid var(--ar-line);padding-top:13px}#trigger-admin .ar-editor .ar-schedule-field input,#trigger-admin .ar-editor .ar-schedule-field select{background:var(--ar-page)}#trigger-admin .ar-editor .ar-schedule-fields{margin-bottom:10px}
@media(max-width:780px){#trigger-admin .ar-list-head,#trigger-admin .ar-target-main{grid-template-columns:minmax(0,1fr) 116px 65px 126px;gap:10px}#trigger-admin .ar-sidebar{padding:13px 18px;flex-wrap:wrap}}
@media(max-width:620px){#trigger-admin .ar-list-head{display:none}#trigger-admin .ar-content{padding:18px 13px}#trigger-admin .ar-nav{order:3;width:100%;justify-content:space-between;gap:0}#trigger-admin .ar-nav button{font-size:11px;padding:7px 6px}#trigger-admin .ar-target-main{grid-template-columns:minmax(0,1fr) auto;gap:9px;padding:13px}#trigger-admin .ar-target-main>div:first-child{grid-column:1/-1}#trigger-admin .ar-next{grid-column:1;grid-row:2}#trigger-admin .ar-state{grid-column:1;grid-row:3}#trigger-admin .ar-target-actions{grid-column:2;grid-row:2/4;max-width:130px}#trigger-admin .ar-section-tools{gap:8px}#trigger-admin .ar-target-count{font-size:11px}#trigger-admin .ar-editor{padding:18px}#trigger-admin .ar-editor .ar-schedule-fields{grid-template-columns:1fr 1fr}}
@media(max-width:360px){#trigger-admin .ar-editor .ar-schedule-fields{grid-template-columns:1fr}#trigger-admin .ar-section-heading h2{font-size:14px}}@media(pointer:coarse){#trigger-admin button,#trigger-admin .ar-button,#trigger-admin .ar-editor input,#trigger-admin .ar-editor select{min-height:44px}#trigger-admin .ar-editor input,#trigger-admin .ar-editor select{font-size:16px}}
</style>
<div class="ar-shell"><aside class="ar-sidebar" aria-label="页面导航"><div class="ar-brand"><span class="ar-monogram" aria-hidden="true">AR</span><div>AgentRouter<small>Cloudflare 调度</small></div></div>
<nav class="ar-nav" aria-label="管理栏目"><button type="button" data-view="repositories" aria-pressed="true" aria-controls="ar-repositories">仓库管理</button><button type="button" data-view="config" aria-pressed="false" aria-controls="ar-config">配置检查</button><button type="button" data-view="logs" aria-pressed="false" aria-controls="ar-logs">运行日志</button><button type="button" data-view="usage" aria-pressed="false" aria-controls="ar-usage">使用说明</button><button type="button" data-action="logout">退出管理</button></nav></aside>
<div class="ar-content"><header class="ar-top"><div><h1 data-page-title>仓库管理</h1><p class="ar-sub" data-session-expiry></p></div><button type="button" class="ar-button" data-action="refresh">刷新状态</button></header>
<section id="ar-repositories" data-section="repositories" aria-label="仓库管理"><div class="ar-section-heading"><h2>运行目标</h2><div class="ar-section-tools"><span class="ar-target-count" data-target-count></span><button type="button" class="ar-button primary" data-action="add-target" disabled>新增目标</button></div></div><div class="ar-list-head"><span>运行目标</span><span>下次触发</span><span>状态</span><span>操作</span></div><div class="ar-targets" data-targets></div></section>
<section id="ar-config" data-section="config" aria-label="配置检查" hidden><h2>运行时配置</h2><p class="ar-sr-only" data-config-summary aria-live="polite"></p><div class="ar-readiness" data-readiness></div><div data-config-items></div><p class="ar-notice" data-config-advice></p><details class="ar-diagnostic" data-config-details><summary>技术诊断</summary><pre><code data-config-diagnostic></code></pre></details></section>
<section id="ar-logs" data-section="logs" aria-label="运行日志" hidden><div class="ar-targets" data-logs></div></section>
<section id="ar-usage" class="ar-usage" data-section="usage" aria-label="使用说明" hidden>
<article><h2>开始使用</h2><ol><li>在“配置检查”查看目标目录、GitHub 凭据与数据库状态；密钥缺失项在 Cloudflare 的 Variables &amp; Secrets 配置并保存部署。</li><li>点击“新增目标”或目标的“设置”。在弹窗的“基本设置”编辑名称、仓库、分支、工作流和 Secret 引用；在“排期设置”编辑模式、时间和间隔，最后点击“保存目标”。新增目标默认允许运行，可在保存前关闭。</li><li>查看“下次触发”，按需展开“运行详情”查看生效排期与执行计划。手动运行须确认；运行记录在“运行日志”查看。</li></ol></article>
<article><h2>时间与执行计划</h2><p>全部时间为北京时间（Asia/Shanghai）。固定模式每天 1～24 个不同时间点；随机模式每天 1～24 次，在包含两端、不跨日的窗口内抽取时间。每天、每个目标独立随机，刷新不重新抽取。</p><p>“当前执行计划”是当前生效的时段，日期、时间和状态分开显示。“上一计划结果”只保留上一份计划最后一个时段的结果，不是上次实际运行，也不是完整历史；被替换且未执行的旧时间不再展示。</p><p>次数是每日计划次数，不是成功次数或累计配额。保存、刷新、暂停后重开不补发过期任务；延迟跨过多个时段时只尝试最近一个，跨日时段跳过。窗口限制计划时间，不能保证平台实际开始时间。</p></article>
<article><h2>间隔与手动运行</h2><p>自动最小间隔支持整数分钟、小时或天，为 1 分钟～365 天，默认 1 分钟；超过一天只支持每天／窗口一个时段。一天以内的固定时间还需满足末次到次日首次的间隔。随机次数、窗口和间隔无法同时满足时会拒绝保存，不会减少次数。</p><p>间隔从同一目标的 Cloudflare 自动请求尝试时刻计算，失败或结果未知也计入；不同目标独立。长间隔的未来计划会等待已知的下次允许尝试时间。间隔不足的时段跳过，不补发、不通知，不表示签到失败。GitHub 排队后的实际开始间隔不由此保证。</p><p>手动运行只受 30 秒冷却限制，不占用自动时段，也不改变自动间隔基线。未收到完整响应时结果可能未知，不要创建新请求重复运行；界面保留原请求 ID 以安全确认。</p><p>暂停、修改排期、跨日、删除日志不会清除已确认的自动基线；缺失或无法关联的旧记录不能恢复，首次自动尝试后建立基线。</p></article>
<article><h2>保存与配置来源</h2><p>首次打开管理页会将有效的 TRIGGER_CONFIG 导入数据库目标目录；未配置变量时从空目录开始，随后直接在页面新增目标。导入后不再需要修改仓库 JSON，修改变量不会覆盖目录。密钥值始终保留在 Cloudflare Secrets，页面只保存引用名称。</p><p>“配置检查”展示已保存目录定义，“仓库管理”和弹窗排期展示生效值，包括导入前已有的单目标覆盖。弹窗统一保存基本信息、开关和排期；目录目标不提供“恢复变量配置”。省略排期默认每天一次、01:00～23:00 随机。保存在刷新、换设备和重部署后保留，不会立即运行或补发。</p><p>更换仓库、工作流或分支不会转移旧身份的设置，不撤销已经提交或执行中的请求。历史记录与防重复记录保留。未保存草稿只在本页内存，刷新状态保留；关闭弹窗或按 Escape 丢弃普通未保存编辑，冲突或结果未知的草稿仍需显式载入保存值。浏览器重载或退出会丢失草稿。多页面修改出现冲突时，核对并选择“载入已保存值 / 丢弃草稿”，不会自动覆盖。</p><p>保存响应未知时可能已写入数据库，界面只读取实际目录与生效状态，不重复提交；草稿保持阻止保存，核对后显式载入已保存值。配置检查仅验证格式和存在性，不验证 GitHub 权限、数据库健康或机器人送达。</p></article>
<article><h2>日志、通知与登录</h2><p>日志按仓库分类，每个工作流／分支目标保留最近 20 条。“GitHub 已受理”只表示触发请求被接受，不表示 Actions 完成或签到成功；最终余额汇总由 Actions 发送，Worker 企业微信只报告触发结果。</p><p>删除日志不改变日程、开关或防重复记录，也不会删除 GitHub 和 Cloudflare 平台日志。正式使用 Cloudflare 前，停用目标仓库旧的 Actions 定时任务，避免重复触发。</p><p>Cookie 会话固定有效 12 小时，刷新或返回页面可恢复，不自动续期。退出撤销当前设备会话；修改用户名、密码或入口值会使旧会话失效。页面不保存密码到浏览器存储；隐藏路径不是认证防线，不要分享入口或密码。</p></article>
</section><p class="ar-feedback" role="status" aria-live="polite" data-feedback></p><footer class="ar-bottom"><span>北京时间 UTC+8</span></footer></div></div>
<dialog class="ar-dialog ar-editor" aria-labelledby="ar-editor-title" data-target-editor></dialog><dialog class="ar-dialog" aria-labelledby="ar-dialog-title" data-confirm-dialog><h2 id="ar-dialog-title" data-dialog-title></h2><code class="ar-dialog-target" data-dialog-target></code><p data-dialog-message></p><p data-dialog-note></p><div class="ar-dialog-actions"><button type="button" class="ar-button" data-cancel>取消</button><button type="button" class="ar-button primary" data-confirm>确认</button></div></dialog></section>`;
}

export function adminClient() {
    if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
    let csrf = "";
    const root = document.querySelector("#trigger-admin");
    if (!root) return;
    const publicView = document.querySelector("[data-public-view]");
    const accessFeedback = document.querySelector("[data-access-feedback]");
    const accessInput = document.querySelector("[data-access-input]");
    const accessUser = document.querySelector("[data-access-username]");
    const accessSubmit = document.querySelector("[data-access-submit]");
    const list = root.querySelector("[data-targets]");
    const feedback = root.querySelector("[data-feedback]");
    const overview = root.querySelector("[data-config-summary]");
    const advice = root.querySelector("[data-config-advice]");
    const readiness = root.querySelector("[data-readiness]");
    const configItems = root.querySelector("[data-config-items]");
    const diagnostic = root.querySelector("[data-config-diagnostic]");
    const logList = root.querySelector("[data-logs]");
    const dialog = root.querySelector("[data-confirm-dialog]");
    const editor = root.querySelector("[data-target-editor]");
    const addButton = root.querySelector('[data-action="add-target"]');
    const refreshButton = root.querySelector('[data-action="refresh"]');
    const logoutButton = root.querySelector('[data-action="logout"]');
    const errors = {
        UNAUTHORIZED: "用户名或密码验证失败，或配置已更新。请重新登录。",
        AUTH_NOT_CONFIGURED: "登录配置缺失或不合法，请在 Cloudflare 配置 ADMIN_USERNAME 和 ADMIN_PASSWORD 后保存部署。",
        NOT_FOUND: "管理入口不可用，请检查访问配置并重新打开管理链接。",
        TARGET_NOT_FOUND: "目标已移除，请刷新状态。", LOG_NOT_FOUND: "日志已移除，请刷新状态。",
        ORIGIN_REJECTED: "请求来源不允许。请在同一管理页面操作。",
        CSRF_REJECTED: "会话验证已改变，请刷新页面后重新操作。",
        SESSION_LIMIT: "活跃会话已满，请等待旧会话到期后登录。",
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
        SCHEDULE_INVALID: "排期未通过校验，请修正输入后保存。",
        SCHEDULE_CONFLICT: "排期已被其他页面修改。草稿保留；请刷新并核对，显式载入已保存值后再编辑。",
        TARGET_CHANGED: "目标身份已改变。草稿不能转移，请刷新并核对新的目标。",
        SCHEDULE_REVISION_LIMIT: "排期版本已达上限，不能继续保存或恢复；请联系管理员。",
        CATALOG_CONFLICT: "目标已被其他页面修改。草稿保留；请核对并显式载入已保存值。",
        CATALOG_INVALID: "目标目录不可用，已停用管理操作。",
        CATALOG_REVISION_LIMIT: "目标目录版本已达上限，不能继续保存。",
        TARGET_INVALID: "目标或排期未通过校验，请修正输入后保存。",
        CREDENTIAL_INVALID: "请选择已配置且格式合法的 GitHub Secret 名称；密钥只在 Cloudflare 配置。",
        CATALOG_MANAGED: "此目标由目录管理，请刷新后在目标设置中保存。",
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
    let loadError = "";
    let catalog = null;
    let selected = null;
    let opener = null;
    const uncertain = new Map();
    const drafts = new Map();
    const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric",
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const dateText = (value) => dateFormat.format(new Date(value));
    const minuteFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
    const minuteText = (value) => minuteFormat.format(new Date(value));
    const clock = (value) => typeof value === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
    const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const validSchedule = (value) => {
        const keys = value?.mode === "fixed" ? ["mode", "times"] : value?.mode === "random" ? ["mode", "count", "window"] : null;
        if (!keys || !exactKeys(value, Object.hasOwn(value, "min_interval_minutes") ? [...keys, "min_interval_minutes"] : keys)) return false;
        const gap = Object.hasOwn(value, "min_interval_minutes") ? value.min_interval_minutes : 1;
        if (!Number.isInteger(gap) || gap < 1 || gap > 525600) return false;
        if (value.mode === "fixed") {
            if (!Array.isArray(value.times) || value.times.length < 1 || value.times.length > 24
                || !value.times.every(clock) || new Set(value.times).size !== value.times.length) return false;
            const minutes = [...value.times].sort().map(minute);
            if (gap > 1440) return minutes.length === 1;
            return minutes.every((at, index) => (minutes[index + 1] ?? minutes[0] + 1440) - at >= gap);
        }
        return Number.isInteger(value.count) && value.count >= 1 && value.count <= 24
            && exactKeys(value.window, ["start", "end"]) && clock(value.window.start) && clock(value.window.end)
            && value.window.start <= value.window.end && (value.count - 1) * gap <= minute(value.window.end) - minute(value.window.start)
            && (gap > 1440 ? value.count === 1 : value.count * gap <= 1440);
    };
    const validSlot = (slot) => slot && typeof slot.at === "string" && Number.isFinite(Date.parse(slot.at))
        && typeof slot.attempted === "boolean" && (knownResult(slot.result)
            || ["PLANNED", "MISSED_DATE", "TARGET_CHANGED", "INTERVAL_SKIPPED"].includes(slot.result));
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
    const bindingFor = target => JSON.stringify([target.id, JSON.stringify([target.repository.toLowerCase(), target.workflow, target.ref])]);
    const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    const validLast = last => exactKeys(last, ["date", "at", "result"]) && iso(last.at)
        && typeof last.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(last.date) && dateText(last.at).slice(0, 10) === last.date
        && (knownResult(last.result) || ["PLANNED", "MISSED_DATE", "TARGET_CHANGED", "INTERVAL_SKIPPED"].includes(last.result));
    const metadataKeys = ["schedule_source", "schedule_revision", "target_binding", "automatic_state", "automatic_last_at", "automatic_next_allowed_at"];
    const validMetadata = target => {
        if (metadataKeys.every(key => target[key] === undefined)) return true;
        const automatic = target.automatic_state === "unknown" ? target.automatic_last_at === null && target.automatic_next_allowed_at === null
            : target.automatic_state === "known" && iso(target.automatic_last_at)
                && (target.automatic_next_allowed_at === null || iso(target.automatic_next_allowed_at)
                    && Date.parse(target.automatic_next_allowed_at) >= Date.parse(target.automatic_last_at));
        return automatic && (target.error ? target.schedule_source === null && target.schedule_revision === null && target.target_binding === null
            : ["database", "variable"].includes(target.schedule_source) && Number.isSafeInteger(target.schedule_revision)
                && target.schedule_revision >= 0 && target.target_binding === bindingFor(target) && validSchedule(target.schedule));
    };
    const editable = target => !target.error && ["database", "variable"].includes(target.schedule_source)
        && validMetadata(target);
    const validTarget = (target) => target && typeof target.id === "string"
        && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.id)
        && [target.repository, target.workflow, target.ref].every((value) => typeof value === "string" && value.length <= 512)
        && typeof target.enabled === "boolean" && ["configured", "missing", "invalid"].includes(target.token_state)
        && [null, "STATE_INVALID", "STORAGE_UNAVAILABLE"].includes(target.error)
        && (target.next_run === null || typeof target.next_run === "string" && Number.isFinite(Date.parse(target.next_run)))
        && Array.isArray(target.history) && target.history.length <= 20 && target.history.every(validRecord)
        && (target.schedule === undefined || validSchedule(target.schedule))
        && (target.schedule_date === undefined || target.schedule_date === null
            || typeof target.schedule_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(target.schedule_date))
        && (target.slots === undefined || Array.isArray(target.slots) && target.slots.length <= 24 && target.slots.every(validSlot))
        && (!Object.hasOwn(target, "schedule_last") || validLast(target.schedule_last))
        && (["name", "token_secret", "catalog_revision"].every(key => target[key] === undefined)
            || typeof target.name === "string" && target.name.trim() === target.name && target.name.length >= 1 && target.name.length <= 64
                && !/[\x00-\x1f\x7f]/.test(target.name) && credentialName(target.token_secret)
                && Number.isSafeInteger(target.catalog_revision) && target.catalog_revision >= 0)
        && validMetadata(target);

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
    function showView(view) {
        for (const name of ["repositories", "config", "logs", "usage"]) {
            root.querySelector(`[data-section="${name}"]`).hidden = name !== view;
            root.querySelector(`[data-view="${name}"]`).setAttribute("aria-pressed", String(name === view));
        }
        root.querySelector("[data-page-title]").textContent = { repositories: "仓库管理", config: "配置检查", logs: "运行日志", usage: "使用说明" }[view];
    }
    function clearLocal(message = "请使用管理员用户名和密码登录。") {
        session++;
        csrf = "";
        accessInput.value = "";
        accessUser.value = "";
        verified = false;
        busy = false;
        accessSubmit.disabled = false;
        logoutButton.disabled = false;
        targets = [];
        pending = null;
        loadError = "";
        catalog = null;
        selected = null;
        opener = null;
        editor.close();
        editor.replaceChildren();
        addButton.disabled = true;
        uncertain.clear();
        drafts.clear();
        list.replaceChildren();
        logList.replaceChildren();
        root.querySelector("[data-target-count]").textContent = "";
        feedback.textContent = "";
        overview.textContent = "";
        advice.textContent = "";
        readiness.replaceChildren();
        configItems.replaceChildren();
        diagnostic.textContent = "";
        root.querySelector("[data-config-details]").open = false;
        root.querySelector("[data-session-expiry]").textContent = "";
        showView("repositories");
        for (const selector of ["[data-dialog-title]", "[data-dialog-target]", "[data-dialog-message]", "[data-dialog-note]"])
            root.querySelector(selector).textContent = "";
        dialog.close();
        root.hidden = true;
        publicView.hidden = false;
        announce(message);
    }
    async function request(path, body, authorization = "") {
        const current = session;
        let response;
        let data;
        try {
            const sent = fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
                credentials: "same-origin", redirect: "error", headers: {
                    ...(authorization ? { Authorization: authorization } : {}),
                    ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: location.origin,
                        ...(!authorization && csrf ? { "X-CSRF-Token": csrf } : {}) }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            authorization = "";
            response = await sent;
            if (current !== session) throw new Error("SESSION_ENDED");
            if (response.status === 401) {
                clearLocal(errors.UNAUTHORIZED);
                throw new Error("SESSION_ENDED");
            }
            data = await response.json();
        } catch { throw new Error(current === session ? "TRANSPORT_UNKNOWN" : "SESSION_ENDED"); }
        if (current !== session) throw new Error("SESSION_ENDED");
        if (response.status === 401 || data?.status === "UNAUTHORIZED" || data?.status === "NOT_FOUND") {
            clearLocal(errors[data?.status] ?? errors.UNAUTHORIZED);
            throw new Error("SESSION_ENDED");
        }
        if (!response.ok) {
            const error = new Error(Object.hasOwn(errors, data?.status) ? data.status : "RESPONSE_INVALID");
            error.status = response.status;
            if (["SCHEDULE_INVALID", "TARGET_INVALID"].includes(data?.status)) error.diagnostic = safeDiagnostic(data.error);
            throw error;
        }
        return data;
    }
    async function authenticate(authorization = "") {
        const current = session;
        try {
            const sent = authorization ? request("/api/admin/session/login", {}, authorization) : request("/api/admin/session");
            authorization = "";
            const data = await sent;
            if (current !== session) return;
            if (data?.status !== "AUTHENTICATED" || typeof data.csrf_token !== "string"
                || !/^[A-Za-z0-9_-]{43}$/.test(data.csrf_token)
                || typeof data.expires_at !== "string" || !(Date.parse(data.expires_at) > Date.now()))
                throw new Error("RESPONSE_INVALID");
            csrf = data.csrf_token;
            verified = true;
            root.hidden = false;
            publicView.hidden = true;
            root.querySelector("[data-session-expiry]").textContent = "会话到期 " + dateText(data.expires_at);
            busy = false;
            await refresh();
        } catch (error) {
            if (current === session) clearLocal(errors[error.message] ?? errors.RESPONSE_INVALID);
        } finally {
            if (current === session) { busy = false; accessSubmit.disabled = false; }
        }
    }
    async function logout() {
        if (logoutButton.disabled) return;
        if (!csrf) { clearLocal(); return; }
        logoutButton.disabled = true;
        const current = ++session;
        busy = true;
        pending = null;
        dialog.close();
        render();
        let message = "服务端退出未确认：结果未知。本页私有信息已清除，但刷新仍可能恢复会话；请稍后登录并重试退出。";
        try {
            const response = await fetch("/api/admin/session/logout", { method: "POST", cache: "no-store",
                credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json",
                    Origin: location.origin, "X-CSRF-Token": csrf }, body: "{}" });
            const data = await response.json();
            if (response.ok && data?.status === "SIGNED_OUT") message = "已退出管理。服务端会话已撤销，请重新登录。";
        } catch { /* Revocation is unconfirmed, not a successful server logout. */ }
        if (current === session) clearLocal(message);
    }
    const hints = {
        JSON_SYNTAX: "检查 JSON 引号、逗号和括号；不要填写注释或多余的末尾逗号。",
        JSON_TYPE: "TRIGGER_CONFIG 必须是 Text 变量中的 JSON 字符串，不是对象绑定。",
        CONFIG_SIZE: "配置不能超过 64000 字符，请减少目标数量。",
        CONFIG_FIELDS: "顶层只包含 version 和 targets。", CONFIG_VERSION: "version 必须为数字 1。",
        TARGETS_INVALID: "targets 必须是数组，最多 100 个目标。",
        TARGET_FIELDS: "目标字段为 id、repository、workflow、ref、token_secret；enabled 和 schedule 可省略。",
        TARGET_FIELD: "检查提示的字段：仓库 owner/repo、工作流 .yml/.yaml、真实分支 ref、Secret 名称或布尔 enabled。",
        DUPLICATE_ID: "每个目标的 id 必须唯一。", DUPLICATE_TARGET: "同一仓库、工作流和分支只能配置一次。",
        SCHEDULE_FIELDS: "fixed 只填写 mode/times；random 只填写 mode/count/window；两种模式可填写 min_interval_minutes。",
        SCHEDULE_MODE: "排期 mode 必须为 fixed 或 random。",
        SCHEDULE_TIMES: "固定时间列表填写 1～24 个互不重复的 HH:mm 时间。",
        SCHEDULE_TIME: "时间严格填写 HH:mm，范围 00:00～23:59；窗口 start 不晚于 end，不支持跨日。",
        SCHEDULE_DUPLICATE: "固定时间不能重复，请删除重复分钟。",
        SCHEDULE_COUNT: "填写 1～24 的整数，且不超过窗口内可选分钟数。",
        SCHEDULE_CAPACITY: "随机次数与最小间隔不能超过窗口分钟容量或每日 1440 分钟，请减少次数、缩短间隔或扩大窗口。",
        SCHEDULE_INTERVAL: "最小间隔填写 1～525600 的整数分钟（最多 365 天）；超过一天只支持一个时段，只约束自动触发。",
        SCHEDULE_SPACING: "固定时间须满足最小间隔，包括最后一次至次日第一次的循环间隔。",
        SCHEDULE_WINDOW: "窗口时间填写 HH:mm，start 不晚于 end；不支持跨日窗口。",
        CONFIG_INVALID: "按字段位置修正配置后保存部署。",
    };
    function safeDiagnostic(value) {
        return { field: typeof value?.field === "string"
            && /^(?:TRIGGER_CONFIG|config|version|target(?:\.(?:id|name|repository|workflow|ref|token_secret|enabled|schedule(?:\.(?:mode|count|min_interval_minutes|times(?:\[\d{1,2}\])?|window(?:\.(?:start|end))?))?))?|schedule(?:\.(?:mode|count|min_interval_minutes|times(?:\[\d{1,2}\])?|window(?:\.(?:start|end))?))?|targets(?:\[(?:[0-9]|[1-9][0-9])\](?:\.(?:id|repository|workflow|ref|token_secret|enabled|schedule(?:\.(?:mode|count|min_interval_minutes|times(?:\[\d{1,2}\])?|window(?:\.(?:start|end))?))?))?)?)$/.test(value.field)
            ? value.field : "config", code: Object.hasOwn(hints, value?.code) ? value.code : "CONFIG_INVALID" };
    }
    function renderConfiguration(health) {
        const state = ["valid", "missing", "invalid"].includes(health.config?.state) ? health.config.state : "unknown";
        const error = safeDiagnostic(health.config?.error);
        const counts = health.github_tokens;
        const countsKnown = state === "valid" && [counts?.configured, counts?.missing, counts?.invalid]
            .every(value => Number.isInteger(value) && value >= 0 && value <= 100);
        const tokens = countsKnown ? `已填写 ${counts.configured} / 缺失 ${counts.missing} / 不合法 ${counts.invalid}` : "— 待确认";
        const binding = typeof health.storage_binding?.configured === "boolean" ? health.storage_binding.configured : null;
        const wecom = ["configured", "missing", "invalid"].includes(health.wecom?.state) ? health.wecom.state : "unknown";
        const configText = state === "valid" ? "JSON 校验通过" : state === "missing" ? "未配置 TRIGGER_CONFIG"
            : state === "invalid" ? `JSON 配置错误：${error.field}（${error.code}）` : "JSON 配置状态待确认";
        overview.textContent = `${configText}；GitHub Token ${tokens}；企业微信 ${{ configured: "已填写（未验证）", missing: "未配置", invalid: "格式不合法", unknown: "待确认" }[wecom]}；数据库 ${binding === true ? "已绑定" : binding === false ? "未绑定" : "待确认"}`;
        const checks = [
            ["JSON 配置", state === "valid" ? "✓ 通过" : state === "missing" ? "! 未配置" : state === "unknown" ? "— 待确认"
                : error.code === "JSON_SYNTAX" ? "! 无法解析" : "! 配置错误",
                state === "valid" ? "" : "未通过校验", state === "valid" ? "" : state === "unknown" ? "warning" : "invalid"],
            ["GitHub 凭据", tokens, "权限未验证",
                !countsKnown || counts.missing || counts.invalid ? "warning" : ""],
            ["数据库绑定", binding === true ? "✓ 已绑定" : binding === false ? "! 缺失" : "— 待确认", "健康未验证",
                binding === true ? "" : binding === false ? "invalid" : "warning"],
            ["企业微信", { configured: "✓ 已填写", missing: "— 未配置", invalid: "! 格式不合法", unknown: "— 待确认" }[wecom],
                "送达未验证", wecom === "configured" ? "" : "warning"],
        ];
        readiness.replaceChildren(...checks.map(([label, status, note, tone]) => {
            const card = element("article", tone);
            card.setAttribute("aria-label", label + "：" + status);
            card.append(element("h3", "", label), element("p", "ar-check-state", status));
            if (note) card.append(element("p", "ar-check-note", note));
            return card;
        }));
        advice.textContent = state === "missing" ? "在 Cloudflare 添加 TRIGGER_CONFIG Text 变量，填写 version:1 和 targets 后保存部署。"
            : state === "invalid" ? error.code === "SCHEDULE_COUNT" && /^targets\[\d{1,2}\]\.schedule\.times$/.test(error.field)
                ? hints.SCHEDULE_TIMES : hints[error.code]
            : state === "unknown" ? "配置检查暂不可用，请刷新或等待更新完成。"
            : countsKnown && counts.missing ? "缺失的 GitHub Token 请按目标 token_secret 名称添加 Secret。" : "";
        advice.hidden = !advice.textContent;
        diagnostic.textContent = `config.state: ${state}\nconfig.error.field: ${state === "invalid" ? error.field : "none"}\nconfig.error.code: ${state === "invalid" ? error.code : "none"}\ngithub_tokens: ${countsKnown ? tokens : "unknown"}\nstorage_binding: ${binding === true ? "configured" : binding === false ? "missing" : "unknown"}\nwecom: ${wecom}`;
        renderConfigItems(health.config?.items, state, error);
    }
    function renderConfigItems(items, state, error) {
        if (!Array.isArray(items) || items.length > 100) {
            configItems.replaceChildren(element("p", "ar-empty", "配置检查明细暂不可用，目标数量与排期无法确认。请刷新或等待更新完成。"));
            return;
        }
        if (!items.length) {
            configItems.replaceChildren(element("p", "ar-empty", state === "valid" ? "暂无配置目标。"
                : state === "missing" ? "尚未填写配置，无法确认目标。" : error.code === "JSON_SYNTAX" ? "JSON 无法解析，目标数量与排期无法确认。" : "配置结构不合法，无法确认目标。"));
            return;
        }
        const table = element("table", "ar-config-table");
        table.setAttribute("aria-label", "运行目标配置检查");
        table.append(element("caption", "", "运行目标配置 · 变量初值"));
        const headings = ["目标 / 仓库", "工作流 / 分支", "排期 / 每天次数", "时间 / 窗口", "GitHub Secret"];
        const head = element("thead");
        const headRow = element("tr");
        for (const title of headings) { const th = element("th", "", title); th.scope = "col"; headRow.append(th); }
        head.append(headRow);
        const body = element("tbody");
        for (const item of items) {
            if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index > 99) continue;
            const row = element("tr", item.error ? "ar-config-error" : "");
            const cells = headings.map(title => { const td = element("td"); td.dataset.label = title; return td; });
            const safe = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : "— 未通过";
            cells[0].append(element("span", "ar-check-note", `第 ${item.index + 1} 个目标`), element("h3", "",
                safe(item.repository, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)),
            element("code", "", safe(item.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)));
            if (item.error) { const error = safeDiagnostic(item.error); cells[0].append(element("span", "ar-field-error", `! 未通过：${error.field}`)); }
            const ref = typeof item.ref === "string" && !/\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(item.ref) ? item.ref : null;
            cells[1].append(element("code", "", safe(item.workflow, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.ya?ml$/)),
                element("p", "", safe(ref, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)));
            const schedule = validSchedule(item.schedule) ? item.schedule : null;
            cells[2].append(element("p", "", schedule ? `${schedule.mode === "fixed" ? "固定" : "随机"} · ${schedule.mode === "fixed" ? schedule.times.length : schedule.count} 次/天` : "— 排期未通过"),
                element("small", "ar-check-note", item.enabled === true ? "JSON 默认开启" : item.enabled === false ? "JSON 默认关闭" : "— 默认开关未通过"));
            if (schedule) {
                const badges = element("div", "ar-badges");
                for (const text of schedule.mode === "fixed" ? schedule.times : [schedule.window.start + "～" + schedule.window.end])
                    badges.append(element("span", "ar-time-badge", text));
                cells[3].append(badges);
                cells[3].append(element("p", "ar-check-note", `自动最小间隔 ${schedule.min_interval_minutes ?? 1} 分钟`));
            } else cells[3].append(element("span", "ar-field-error", "— 时间未通过"));
            cells[4].append(element("code", "", safe(item.token_secret, /^[A-Z][A-Z0-9_]{0,63}$/)), element("p", "ar-check-note",
                { configured: "已填写 · 权限未验证", missing: "! 缺失", invalid: "! 格式不合法" }[item.token_state] ?? "— 无法确认"));
            row.append(...cells);
            body.append(row);
        }
        table.append(head, body);
        configItems.replaceChildren(table);
    }
    function acceptTargets(data) {
        if (data?.status !== "OK" || !Array.isArray(data.targets) || data.targets.length > 100
            || !data.targets.every(validTarget) || new Set(data.targets.map(target => target.id)).size !== data.targets.length)
            throw new Error("RESPONSE_INVALID");
        for (const [id, draft] of drafts) {
            const target = data.targets.find(item => item.id === id);
            if (id === "__new") continue;
            if (!target || !target.error && target.target_binding !== draft.binding) drafts.delete(id);
            else if (!target.error && target.schedule_revision !== draft.revision && !draft.blocked) {
                draft.blocked = true;
                draft.message = errors.SCHEDULE_CONFLICT;
            }
        }
        targets = data.targets;
    }
    const credentialName = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
        && !["DEBUG_ACCESS_TOKEN", "ADMIN_USERNAME", "ADMIN_PASSWORD", "WECOM_WEBHOOK_URL", "TRIGGER_CONFIG", "SCHEDULES"].includes(value);
    const validConfigTarget = target => {
        const keys = ["id", "name", "repository", "workflow", "ref", "token_secret", "enabled"];
        return exactKeys(target, Object.hasOwn(target ?? {}, "schedule") ? [...keys, "schedule"] : keys)
            && typeof target.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.id)
            && typeof target.name === "string" && target.name.trim() === target.name && target.name.length >= 1 && target.name.length <= 64
            && !/[\x00-\x1f\x7f]/.test(target.name)
            && typeof target.repository === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(target.repository)
            && typeof target.workflow === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(target.workflow)
            && typeof target.ref === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target.ref)
            && !/\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(target.ref)
            && typeof target.token_secret === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(target.token_secret)
            && typeof target.enabled === "boolean" && (target.schedule === undefined || validSchedule(target.schedule));
    };
    function acceptCatalog(data) {
        if (!exactKeys(data, ["status", "version", "revision", "items", "credentials"]) || data.status !== "OK" || data.version !== 1
            || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.items) || data.items.length > 100
            || !data.items.every(validConfigTarget) || new Set(data.items.map(item => item.id)).size !== data.items.length
            || new Set(data.items.map(item => JSON.stringify([item.repository.toLowerCase(), item.workflow, item.ref]))).size !== data.items.length
            || !Array.isArray(data.credentials) || !data.credentials.every(credentialName)
            || new Set(data.credentials).size !== data.credentials.length) throw new Error("RESPONSE_INVALID");
        for (const draft of drafts.values()) if (draft.catalogRevision !== undefined && draft.catalogRevision !== data.revision) {
            draft.blocked = true; draft.message = errors.CATALOG_CONFLICT;
        }
        catalog = data;
    }
    async function readManagedTargets() {
        acceptCatalog(await request("/api/admin/catalog"));
        acceptTargets(await request("/api/admin/targets"));
    }
    function closeEditor(discard = false) {
        if (discard && !busy && !drafts.get(selected)?.blocked) drafts.delete(selected);
        selected = null; editor.close(); editor.replaceChildren();
        if (opener?.isConnected !== false) opener?.focus();
        opener = null;
    }
    function openEditor(target, from) {
        if (busy || !verified || !catalog || target.error) return;
        selected = target.id; opener = from ?? document.activeElement;
        const draft = scheduleDraft(target); draft.tab = "basic"; draft.open = true; drafts.set(target.id, draft);
        renderEditor(); editor.showModal();
    }
    function renderEditor() {
        if (!selected || !verified) return;
        const target = selected === "__new" ? { id: "__new", enabled: true, schedule: { mode: "random", count: 1, window: { start: "01:00", end: "23:00" } } }
            : targets.find(item => item.id === selected);
        if (!target || target.error || selected !== "__new" && !editable(target)) { closeEditor(); return; }
        const draft = scheduleDraft(target);
        const head = element("div", "ar-editor-head");
        const title = element("h2", "", selected === "__new" ? "新增目标" : "目标设置"); title.id = "ar-editor-title";
        head.append(title, button("关闭", "editor-close", () => closeEditor(true), false, "quiet"));
        const context = element("p", "ar-editor-context", selected === "__new" ? "新目标 · 保存后生效，不立即运行"
            : `${target.name ?? target.id} · ${target.repository} / ${target.workflow} / ${target.ref} · ${target.id}`);
        editor.replaceChildren(head, context, scheduleEditor(target));
    }
    function scheduleDraft(target) {
        const schedule = target.schedule;
        const config = catalog?.items.find(item => item.id === target.id);
        const gap = schedule.min_interval_minutes ?? 1;
        const unit = config || target.id === "__new" ? gap % 1440 === 0 ? "day" : gap % 60 === 0 ? "hour" : "minute" : "minute";
        return drafts.get(target.id) ?? { binding: target.target_binding, revision: target.schedule_revision,
            ...(config || target.id === "__new" ? { catalogRevision: catalog.revision, name: config?.name ?? "", repository: config?.repository ?? "",
                workflow: config?.workflow ?? "Checkin.yml", ref: config?.ref ?? "main", token_secret: config?.token_secret ?? catalog.credentials[0] ?? "",
                enabled: target.enabled, tab: "basic" } : {}),
            mode: schedule.mode, times: [...(schedule.times ?? ["08:30"])], count: String(schedule.count ?? 1),
            start: schedule.window?.start ?? "01:00", end: schedule.window?.end ?? "23:00",
            interval: String(gap / { minute: 1, hour: 60, day: 1440 }[unit]), intervalUnit: unit, open: false, blocked: false, message: "" };
    }
    function scheduleEditor(target) {
        const current = session;
        const draft = scheduleDraft(target);
        const managed = draft.catalogRevision !== undefined;
        const disabled = busy || target.id !== "__new" && !editable(target);
        const details = element("div", "ar-schedule");
        details.dataset.scheduleTargetId = target.id;
        details.open = draft.open;
        details.addEventListener("toggle", () => {
            if (current !== session || !verified || details.isConnected === false) return;
            draft.open = details.open;
            if (details.open || drafts.has(target.id)) drafts.set(target.id, draft);
        });
        const form = element("form", "ar-schedule-form");
        form.noValidate = true;
        form.dataset.scheduleForm = target.id;
        const count = element("output", "ar-check-note");
        const updateCount = () => { count.textContent = `计划 ${draft.mode === "fixed" ? draft.times.length : draft.count} 次/天`; };
        updateCount();
        const message = element("p", "ar-field-error", draft.message || "");
        message.id = "ar-schedule-message-" + target.id;
        message.setAttribute("role", "status");
        message.setAttribute("aria-live", "polite");
        const remember = () => {
            draft.open = true;
            drafts.set(target.id, draft);
            if (!draft.blocked) { draft.message = "草稿未保存"; message.textContent = draft.message; }
            updateCount();
        };
        const input = (name, labelText, type, value, handler, min, max, options = [["random", "随机"], ["fixed", "固定"]]) => {
            const label = element("label", "ar-schedule-field", labelText);
            const control = element(type === "select" ? "select" : "input");
            control.id = "ar-schedule-" + target.id + "-" + name;
            label.htmlFor = control.id;
            control.dataset.scheduleField = name;
            if (type === "select") {
                for (const [value, text] of options) {
                    const option = element("option", "", text); option.value = value; control.append(option);
                }
            } else { control.type = type; control.required = true; }
            control.value = value;
            control.disabled = disabled;
            if (min !== undefined) { control.min = String(min); control.max = String(max); control.step = "1"; }
            control.setAttribute("aria-describedby", message.id);
            control.addEventListener(type === "select" ? "change" : "input", () => {
                if (busy || current !== session || !verified || control.isConnected === false) return;
                handler(control.value); remember();
                if (type === "select") { render(); document.getElementById(control.id)?.focus(); }
            });
            label.append(control);
            return label;
        };
        if (managed) {
            const tabs = element("div", "ar-editor-tabs");
            for (const [value, title] of [["basic", "基本设置"], ["schedule", "排期设置"]]) {
                const tab = button(title, "tab-" + value, () => {
                    if (current !== session || !verified || busy) return;
                    draft.tab = value; drafts.set(target.id, draft); renderEditor();
                }, busy, "quiet");
                tab.setAttribute("aria-pressed", String((draft.tab ?? "basic") === value)); tabs.append(tab);
            }
            form.append(tabs);
            const basic = element("div", "ar-editor-basic"); basic.hidden = draft.tab === "schedule";
            basic.append(input("name", "显示名称", "text", draft.name, value => { draft.name = value; }),
                input("repository", "GitHub 仓库（owner/repo）", "text", draft.repository, value => { draft.repository = value; }),
                input("ref", "分支 / ref", "text", draft.ref, value => { draft.ref = value; }),
                input("workflow", "工作流（.yml / .yaml）", "text", draft.workflow, value => { draft.workflow = value; }),
                input("token_secret", "GitHub Secret 名称（不填写密钥）", "select", draft.token_secret, value => { draft.token_secret = value; }, undefined, undefined,
                    [...new Set([draft.token_secret, ...catalog.credentials])].map(value => [value, value || "暂无可用凭据，请在 Cloudflare 配置"])));
            const enabled = element("label", "ar-switch-label", "允许运行"); const toggle = element("input", "ar-switch-input");
            toggle.type = "checkbox"; toggle.checked = draft.enabled; toggle.disabled = disabled; toggle.dataset.scheduleField = "enabled";
            toggle.addEventListener("change", () => { if (current === session && verified && !busy && toggle.isConnected !== false) { draft.enabled = toggle.checked; remember(); } });
            enabled.append(toggle); basic.append(enabled, element("p", "ar-check-note", "密钥仍由 Cloudflare Secrets 管理；这里只保存引用名称。修改身份不会撤销已提交的运行。"));
            form.append(basic);
        }
        const schedulePanel = element("div", "ar-editor-schedule"); schedulePanel.hidden = managed && draft.tab !== "schedule";
        const fields = element("div", "ar-schedule-fields");
        fields.append(input("mode", "模式", "select", draft.mode, value => { draft.mode = value; }));
        if (draft.mode === "random") {
            fields.append(input("count", "随机次数 / 天", "number", draft.count, value => { draft.count = value; }, 1, 24),
                input("start", "窗口开始（北京时间）", "time", draft.start, value => { draft.start = value; }),
                input("end", "窗口结束（北京时间）", "time", draft.end, value => { draft.end = value; }));
        }
        fields.append(input("interval", "自动最小间隔（整数）", "number", draft.interval, value => { draft.interval = value; }, 1,
            { minute: 525600, hour: 8760, day: 365 }[draft.intervalUnit]),
            input("interval-unit", "间隔单位", "select", draft.intervalUnit, value => { draft.intervalUnit = value; }, undefined, undefined,
                [["minute", "分钟"], ["hour", "小时"], ["day", "天"]]));
        schedulePanel.append(fields, element("p", "ar-check-note", "1 分钟～365 天；超过一天只能安排一个时段。自动尝试间隔独立于手动运行；保存不立即运行或补发。"));
        if (draft.mode === "fixed") {
            const times = element("div", "ar-schedule-times");
            draft.times.forEach((time, index) => {
                const row = element("div", "ar-schedule-time");
                const label = input("time", `固定时间 ${index + 1}（北京时间）`, "time", time, value => { draft.times[index] = value; });
                label.htmlFor = label.children[0].id = "ar-schedule-" + target.id + "-time-" + index;
                row.append(label, button("删除时间", "schedule-remove", () => {
                    if (busy || draft.times.length <= 1) return;
                    draft.times.splice(index, 1); remember(); render();
                    document.getElementById("ar-schedule-" + target.id + "-time-" + Math.min(index, draft.times.length - 1))?.focus();
                }, disabled || draft.times.length <= 1, "quiet danger"));
                times.append(row);
            });
            times.append(button("添加固定时间", "schedule-add", () => {
                if (busy || draft.times.length >= 24) return;
                draft.times.push(""); remember(); render();
                document.getElementById("ar-schedule-" + target.id + "-time-" + (draft.times.length - 1))?.focus();
            }, disabled || draft.times.length >= 24));
            schedulePanel.append(times);
        }
        form.append(schedulePanel);
        const actions = element("div", "ar-schedule-actions");
        const save = button(managed ? "保存目标" : "保存排期", "schedule-save", () => {}, disabled || draft.blocked
            || (managed ? draft.catalogRevision : target.schedule_revision) === Number.MAX_SAFE_INTEGER, "primary");
        save.type = "submit";
        actions.append(save);
        if (!managed) actions.append(button("恢复变量配置", "schedule-reset", () => {
            if (disabled || draft.blocked) return;
            drafts.set(target.id, draft); confirm("schedule/reset", target);
        }, disabled || draft.blocked || target.schedule_revision === Number.MAX_SAFE_INTEGER));
        actions.append(button("载入已保存值 / 丢弃草稿", "schedule-load", () => loadSavedSchedule(target), disabled, "quiet"));
        form.append(count, message, actions);
        form.addEventListener("submit", event => {
            event.preventDefault();
            if (disabled || draft.blocked || busy || current !== session || !verified || form.isConnected === false) return;
            remember();
            void (managed ? saveCatalogTarget(target) : saveSchedule(target, false));
        });
        details.append(form);
        return details;
    }
    async function loadSavedSchedule(target) {
        if (busy || !csrf || !verified) return;
        const current = session;
        busy = true; render();
        try {
            if (drafts.get(target.id)?.catalogRevision !== undefined) await readManagedTargets();
            else acceptTargets(await request("/api/admin/targets"));
            if (target.id === "__new") { drafts.delete("__new"); renderEditor(); announce("已丢弃新目标草稿。"); return; }
            const saved = targets.find(item => item.id === target.id);
            if (!saved || !editable(saved)) throw new Error(saved?.error ?? "TARGET_NOT_FOUND");
            drafts.delete(target.id);
            if (current === session) announce("已载入保存值，草稿已丢弃。");
        } catch (error) {
            if (current === session) announce(errors[error.message] ?? errors.RESPONSE_INVALID);
        } finally {
            if (current === session) { busy = false; render(); }
        }
    }
    function draftSchedule(draft) {
        const amount = Number(draft.interval), factor = { minute: 1, hour: 60, day: 1440 }[draft.intervalUnit];
        if (!Number.isInteger(amount) || amount < 1 || !factor || amount * factor > 525600) throw new Error("SCHEDULE_INVALID");
        const gap = amount * factor;
        const schedule = { mode: draft.mode, ...(draft.mode === "fixed" ? { times: [...draft.times].sort() }
            : { count: Number(draft.count), window: { start: draft.start, end: draft.end } }),
            ...(gap === 1 ? {} : { min_interval_minutes: gap }) };
        if (!validSchedule(schedule)) throw new Error("SCHEDULE_INVALID");
        return schedule;
    }
    const sameConfig = (left, right) => ["name", "repository", "workflow", "ref", "token_secret", "enabled"].every(key => left[key] === right[key])
        && left.schedule?.mode === right.schedule?.mode && (left.schedule?.min_interval_minutes ?? 1) === (right.schedule?.min_interval_minutes ?? 1)
        && (left.schedule?.mode === "fixed" ? JSON.stringify(left.schedule.times) === JSON.stringify(right.schedule.times)
            : left.schedule?.count === right.schedule?.count && left.schedule?.window.start === right.schedule?.window.start && left.schedule?.window.end === right.schedule?.window.end);
    async function saveCatalogTarget(target) {
        const draft = drafts.get(target.id);
        if (!draft || draft.blocked || busy || !verified || !csrf || !catalog || draft.catalogRevision !== catalog.revision) return;
        const current = session;
        let body;
        try {
            const item = { ...(target.id === "__new" ? {} : { id: target.id }), name: draft.name, repository: draft.repository,
                ref: draft.ref, workflow: draft.workflow, token_secret: draft.token_secret, enabled: draft.enabled, schedule: draftSchedule(draft) };
            if (!validConfigTarget({ ...item, id: target.id === "__new" ? "new" : target.id })) throw new Error("TARGET_INVALID");
            if (!catalog.credentials.includes(item.token_secret)) throw new Error("CREDENTIAL_INVALID");
            body = { revision: draft.catalogRevision, target: item };
        } catch (error) {
            draft.message = errors[error.message] + (error.message === "SCHEDULE_INVALID" ? " " + hints.SCHEDULE_INTERVAL : "");
            render(); announce(draft.message); return;
        }
        busy = true; render();
        let message;
        try {
            const data = await request("/api/admin/catalog", body);
            if (!exactKeys(data, ["status", "revision", "target"]) || data.status !== "CATALOG_UPDATED" || data.revision !== body.revision + 1
                || !validConfigTarget(data.target) || target.id !== "__new" && data.target.id !== target.id || !sameConfig(data.target, body.target))
                throw new Error("TRANSPORT_UNKNOWN");
            await readManagedTargets();
            const saved = targets.find(item => item.id === data.target.id);
            if (!saved || !editable(saved)) throw new Error("TRANSPORT_UNKNOWN");
            drafts.delete(target.id);
            if (selected === target.id) closeEditor();
            message = "目标已保存，未触发运行。";
        } catch (error) {
            if (current !== session || error.message === "SESSION_ENDED") return;
            message = errors[error.message] ?? errors.RESPONSE_INVALID;
            if (["CATALOG_CONFLICT", "CATALOG_REVISION_LIMIT", "TARGET_CHANGED"].includes(error.message)) draft.blocked = true;
            else if (error.message === "TARGET_INVALID") {
                const issue = error.diagnostic ?? safeDiagnostic(null); message += ` ${issue.field}：${hints[issue.code]}`;
            } else if (error.status === 503 || ["TRANSPORT_UNKNOWN", "RESPONSE_INVALID"].includes(error.message)) {
                draft.blocked = true;
                message = "保存结果未确认，可能已写入目录；Alarm / 自动状态仍未知。正在读取实际值，不会重新提交；草稿保留。";
                try {
                    await readManagedTargets();
                    const saved = catalog.items.find(item => target.id === "__new" ? sameConfig(item, body.target) : item.id === target.id);
                    const runtime = targets.find(item => item.id === saved?.id);
                    if (!runtime || !editable(runtime)) throw new Error("RESPONSE_INVALID");
                    message += sameConfig(saved, body.target) ? " 已读回匹配的目录值；请核对生效状态并载入已保存值。"
                        : " 已读回目录，提交值尚未确认；请核对并载入已保存值。";
                } catch {
                    if (current !== session) return;
                    message += " 实际设置读取也未确认，请稍后刷新再核对。";
                }
            }
            drafts.set(target.id, draft); draft.message = message;
        } finally {
            if (current === session) { busy = false; render(); }
        }
        if (current === session && verified) announce(message);
    }
    async function saveSchedule(target, reset) {
        const draft = drafts.get(target.id) ?? scheduleDraft(target);
        if (!csrf || !verified || busy || !editable(target) || draft.blocked
            || draft.binding !== target.target_binding || draft.revision !== target.schedule_revision
            || draft.revision === Number.MAX_SAFE_INTEGER) return;
        const current = session;
        const body = { binding: draft.binding, revision: draft.revision };
        if (!reset) {
            try { body.schedule = draftSchedule(draft); }
            catch { draft.message = errors.SCHEDULE_INVALID + " " + hints.SCHEDULE_INTERVAL; drafts.set(target.id, draft); render(); announce(draft.message); return; }
        }
        drafts.set(target.id, draft);
        busy = true; render();
        let message;
        try {
            const data = await request(`/api/admin/targets/${encodeURIComponent(target.id)}/schedule${reset ? "/reset" : ""}`, body);
            if (data?.status !== (reset ? "SCHEDULE_RESET" : "SCHEDULE_UPDATED") || !validTarget(data.target)
                || !editable(data.target) || data.target.target_binding !== body.binding || data.target.schedule_revision !== body.revision + 1
                || data.target.schedule_source !== (reset ? "variable" : "database")) throw new Error("TRANSPORT_UNKNOWN");
            targets = targets.map(item => item.id === target.id ? data.target : item);
            drafts.delete(target.id);
            message = reset ? "已恢复变量配置，未触发运行。"
                : "排期已保存，未触发运行。";
        } catch (error) {
            if (current !== session || error.message === "SESSION_ENDED") return;
            message = errors[error.message] ?? errors.RESPONSE_INVALID;
            if (error.message === "SCHEDULE_INVALID") {
                const diagnostic = error.diagnostic ?? safeDiagnostic(null);
                message += ` ${diagnostic.field}：${hints[diagnostic.code]}`;
            } else if (["SCHEDULE_CONFLICT", "TARGET_CHANGED", "SCHEDULE_REVISION_LIMIT"].includes(error.message)) draft.blocked = true;
            else if (error.status === 503 || ["TRANSPORT_UNKNOWN", "RESPONSE_INVALID"].includes(error.message)) {
                draft.blocked = true;
                message = "保存结果未确认：设置可能已提交，Alarm / 完整自动状态仍未知。正在读取实际值，不会重新提交；草稿保留。";
                try {
                    acceptTargets(await request("/api/admin/targets"));
                    const saved = targets.find(item => item.id === target.id);
                    if (!saved || !editable(saved)) throw new Error("RESPONSE_INVALID");
                    message += " 已读取实际设置，请核对来源与版本；显式载入已保存值以丢弃草稿。";
                } catch {
                    if (current !== session) return;
                    message += " 实际设置读取也未确认，请稍后刷新再核对。";
                }
            }
            if (drafts.get(target.id) === draft) draft.message = message;
        } finally {
            if (current === session) { busy = false; render(); }
        }
        if (current === session && verified) announce(message);
    }
    function render() {
        const cards = targets.map((target) => {
            const blocked = busy || Boolean(target.error);
            const runnable = target.enabled && target.token_state === "configured" && !target.error;
            const tone = target.error || target.token_state !== "configured" ? "warning" : !target.enabled ? "paused" : "";
            const article = element("article", "ar-target");
            article.dataset.targetId = target.id;
            article.setAttribute("aria-label", target.name ?? target.repository);
            const main = element("div", "ar-target-main");
            const description = element("div");
            const heading = element("div", "ar-repo-line");
            heading.append(element("h3", "", target.name ?? target.id));
            const state = element("span", "ar-state " + tone,
                target.error ? "状态不可用" : !target.enabled ? "已关闭" : target.token_state === "configured" ? "已开启" : "Token 不可用");
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
            next.append(element("span", "ar-next-label", "下次自动触发"), time);
            description.append(heading, element("p", "ar-repository", target.repository), metadata);
            if (target.error) description.append(element("p", "ar-field-error", errors[target.error]));
            const details = element("details", "ar-run-details");
            details.append(element("summary", "", "运行详情"));
            if (editable(target)) {
                const schedule = target.schedule;
                const gap = schedule.min_interval_minutes ?? 1;
                const interval = gap % 1440 === 0 ? `${gap / 1440} 天` : gap % 60 === 0 ? `${gap / 60} 小时` : `${gap} 分钟`;
                const mode = schedule.mode === "fixed" ? "固定" : "随机";
                const count = schedule.mode === "fixed" ? schedule.times.length : schedule.count;
                details.append(element("p", "ar-last", `生效排期：${mode}${gap > 1440 ? `时段 ${count} 个` : ` ${count} 次/天`} · 自动最小间隔 ${interval}`),
                    element("p", "", `来源：${target.schedule_source === "database" ? "数据库设置" : "变量配置"} · 版本 ${target.schedule_revision}`),
                    element("p", "", target.automatic_state === "known" ? `上次自动尝试 ${dateText(target.automatic_last_at)}` : "自动基线未建立"));
                if (target.automatic_state === "known") details.append(element("p", "", `下次允许自动尝试 ${target.automatic_next_allowed_at ? dateText(target.automatic_next_allowed_at) : "待确认"}`));
            }
            for (const [label, date, items] of [["当前执行计划", target.schedule_date, target.slots],
                ["上一计划结果", target.schedule_last?.date, target.schedule_last && target.schedule_last.result !== "PLANNED" ? [target.schedule_last] : undefined]]) {
                if (items === undefined) continue;
                const table = element("table", "ar-plan-table");
                const caption = element("caption"), heading = element("div", "ar-plan-heading");
                heading.append(element("span", "", label));
                if (date) { const day = element("time", "", date); day.dateTime = date; heading.append(day); }
                caption.append(heading); table.append(caption);
                const head = element("thead"), row = element("tr");
                for (const title of ["时间", "状态"]) { const th = element("th", "", title); th.scope = "col"; row.append(th); }
                head.append(row); table.append(head);
                const body = element("tbody");
                for (const slot of items) {
                    const skipped = ["MISSED_DATE", "TARGET_CHANGED", "INTERVAL_SKIPPED"].includes(slot.result);
                    const status = slot.result === "INTERVAL_SKIPPED" ? "最小间隔未到，已跳过（不补发）"
                        : slot.result === "PLANNED" ? "待执行" : skipped ? "已跳过（不补发）"
                        : slot.result === "DISPATCH_ACCEPTED" ? "GitHub 已受理" : slot.result === "DISPATCH_UNKNOWN" ? "结果未知"
                            : "GitHub 拒绝";
                    const row = element("tr", skipped ? "skipped" : slot.result === "DISPATCH_ACCEPTED"
                        ? "accepted" : slot.result === "DISPATCH_UNKNOWN" ? "unknown" : "");
                    const at = element("time", "", minuteText(slot.at));
                    at.dateTime = slot.at;
                    const timeCell = element("td"); timeCell.append(at);
                    row.append(timeCell, element("td", "", status)); body.append(row);
                }
                if (!items.length) { const row = element("tr"), cell = element("td", "ar-check-note", "暂无执行计划"); cell.colSpan = 2; row.append(cell); body.append(row); }
                table.append(body); details.append(table);
            }
            if (details.children.length > 1) description.append(details);
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
            if (editable(target)) actions.append(button("设置", "settings", () => openEditor(target), blocked, "quiet"));
            actions.append(label, button(uncertain.has(target.id) ? "重试原请求" : "运行", "run",
                () => confirm("run", target), blocked || !runnable, "primary"));
            main.append(description, next, state, actions);
            article.append(main);
            if (drafts.get(target.id)?.message) article.append(element("p", "ar-card-feedback", drafts.get(target.id).message));
            return article;
        });
        if (!targets.length) cards.push(element("p", "ar-empty", loadError ? "目标读取失败：" + loadError : "暂无目标，点击“新增目标”设置仓库与排期。"));
        list.replaceChildren(...cards);
        root.querySelector("[data-target-count]").textContent = `${targets.length} 个目标 · ${targets.filter((target) => target.enabled && !target.error).length} 个开启`;
        refreshButton.disabled = busy;
        addButton.disabled = busy || !verified || !catalog || Boolean(loadError) || catalog.items.length >= 100;
        renderEditor();
        renderLogs();
    }
    function renderLogs() {
        const groups = new Map();
        for (const target of targets) {
            const key = target.repository.toLowerCase();
            let group = groups.get(key);
            if (!group) {
                group = element("article", "ar-target");
                group.dataset.repository = target.repository;
                const heading = element("div", "ar-target-main");
                heading.append(element("h2", "", target.repository));
                group.append(heading);
                groups.set(key, group);
            }
            const blocked = busy || Boolean(target.error);
            const logs = element("details", "ar-logs");
            logs.open = true;
            logs.dataset.logTargetId = target.id;
            logs.append(element("summary", "", `${target.workflow} / ${target.ref} / ${target.id} (${target.history.length})`));
            const content = element("div", "ar-log-content");
            const toolbar = element("div", "ar-log-toolbar");
            toolbar.append(element("span", "", "仅保留最近 20 条"), button("清空此目标日志", "clear",
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
            if (!target.history.length) content.append(element("p", "ar-empty", target.error ? errors[target.error] + "，暂不能读取记录" : "暂无调度记录"));
            logs.append(content);
            group.append(logs);
        }
        logList.replaceChildren(...(groups.size ? [...groups.values()] : [element("p", "ar-empty",
            loadError ? "日志读取失败：" + loadError : "暂无配置目标或调度记录。")]));
    }
    async function refresh(announceSuccess = true) {
        if (!csrf || busy) return;
        const current = session;
        let healthRead = false;
        busy = true;
        loadError = "";
        accessSubmit.disabled = true;
        refreshButton.disabled = true;
        if (verified) render();
        try {
            overview.textContent = "正在读取配置状态…";
            readiness.replaceChildren();
            configItems.replaceChildren(element("p", "ar-empty", "正在读取配置状态…"));
            diagnostic.textContent = "";
            const health = await request("/health");
            if (current !== session) return;
            if (health?.config) {
                renderConfiguration(health);
                healthRead = true;
                verified = true;
                root.hidden = false;
                publicView.hidden = true;
                if (!["valid", "missing"].includes(health.config.state)) { showView("config"); throw new Error("CONFIG_INVALID"); }
            } else { overview.textContent = "配置状态暂不可用"; throw new Error("RESPONSE_INVALID"); }
            await readManagedTargets();
            if (current !== session) return;
            if (health.config.source === "variable") {
                const updatedHealth = await request("/health");
                if (updatedHealth?.config?.state !== "valid" || updatedHealth.config.source !== "database") throw new Error("RESPONSE_INVALID");
                renderConfiguration(updatedHealth);
            }
            verified = true;
            root.hidden = false;
            publicView.hidden = true;
            accessFeedback.textContent = "";
            if (announceSuccess) announce("状态已刷新。");
        } catch (error) {
            if (current === session && error.message !== "SESSION_ENDED") {
                targets = [];
                catalog = null; closeEditor();
                loadError = errors[error.message] ?? errors.RESPONSE_INVALID;
                if (!healthRead) {
                    overview.textContent = "配置状态暂不可用，无法确认。";
                    configItems.replaceChildren(element("p", "ar-empty", "配置读取失败，目标与凭据状态无法确认。请稍后刷新。"));
                }
                announce(loadError);
            }
        } finally {
            if (current === session) { busy = false; accessSubmit.disabled = false; if (verified) render(); else refreshButton.disabled = false; }
        }
    }
    function confirm(action, target, logId) {
        if (busy || !verified || target.error) return;
        pending = { action, target, logId };
        root.querySelector("[data-dialog-title]").textContent = action === "schedule/reset" ? "恢复变量配置？" : action === "run" ? "确认手动运行？"
            : action === "clear" ? "清空这个运行目标的日志？" : "删除这条调度日志？";
        root.querySelector("[data-dialog-target]").textContent = target.repository + " / " + target.workflow + " / " + target.ref + " / " + target.id;
        root.querySelector("[data-dialog-message]").textContent = action === "schedule/reset"
            ? "将撤销此目标的数据库排期覆盖，恢复当前变量配置。未保存草稿会在恢复成功后丢弃。"
            : action === "run"
            ? uncertain.has(target.id) ? "上次响应未知。只重试原请求 ID，查询或完成同一请求，不创建新运行。"
                : "将向 GitHub 提交一次手动触发，不改变下一次自动运行时间。"
            : action === "clear" ? `将删除该目标管理页中的 ${target.history.length} 条记录。` : "只删除管理页中的这一条记录。";
        root.querySelector("[data-dialog-note]").textContent = action === "schedule/reset"
            ? "不立即运行或补发；不改变开关、手动请求记录、日志或可信自动基线。"
            : action === "run"
            ? "GitHub 已受理不等于签到成功；通知单独显示，不自动重试。"
            : "不删除日程、开关、防重复请求记录或 Cloudflare / GitHub 平台日志。";
        const confirmButton = root.querySelector("[data-confirm]");
        confirmButton.textContent = action === "schedule/reset" ? "确认恢复变量" : action === "run" ? uncertain.has(target.id) ? "重试原请求" : "确认运行"
            : action === "clear" ? "确认清空" : "确认删除";
        confirmButton.className = "ar-button " + (action === "run" ? "primary" : "danger");
        dialog.showModal();
    }
    async function mutate(action, target, body) {
        if (!csrf || !verified || busy || target.error) return;
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
                acceptTargets({ status: "OK", targets: targets.map(item => item.id === target.id ? data.target : item) });
                if (catalog?.items.some(item => item.id === target.id)) acceptCatalog(await request("/api/admin/catalog"));
                message = `${target.repository} 已${data.target.enabled ? "开启" : "关闭"}，数据库开关已保存。`;
            } else if (action === "run") {
                if (!knownResult(data?.status) || typeof data.cached !== "boolean" || !validRecord(data.record)
                    || data.record.id.toLowerCase() !== body.request_id.toLowerCase() || data.record.result !== data.status)
                    throw new Error("TRANSPORT_UNKNOWN");
                uncertain.delete(target.id);
                message = `${data.cached ? "原请求结果：" : "手动触发："}${resultText(data.status)}。${notifications[data.record.notification]}。下一次自动日程不变。`;
            } else {
                if (data?.status !== (action === "clear" ? "HISTORY_CLEARED" : "HISTORY_DELETED")) throw new Error("RESPONSE_INVALID");
                target.history = action === "clear" ? [] : target.history.filter((record) => record.id !== body.log_id);
                message = action === "clear" ? "已清空此目标日志，同仓库的其他目标、日程与防重复记录保持不变。" : "已删除一条调度日志，日程与防重复记录保持不变。";
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
    logoutButton.addEventListener("click", () => logout());
    refreshButton.addEventListener("click", () => refresh());
    addButton.addEventListener("click", () => {
        if (addButton.disabled) return;
        openEditor({ id: "__new", enabled: true, schedule: { mode: "random", count: 1, window: { start: "01:00", end: "23:00" } } }, addButton);
    });
    editor.addEventListener("cancel", event => { event.preventDefault(); closeEditor(true); });
    document.querySelector("[data-access-form]").addEventListener("submit", (event) => {
        event.preventDefault();
        if (busy) return;
        let user = accessUser.value;
        let secret = accessInput.value;
        clearLocal("正在验证用户名和密码…");
        if (!user || user.length > 64 || /[:\s\x00-\x1f\x7f]/.test(user) || secret.length < 12 || secret.length > 256
            || /[\x00-\x1f\x7f]/.test(secret)) { announce(errors.UNAUTHORIZED); return; }
        let authorization = "Basic " + btoa(String.fromCharCode(...new TextEncoder().encode(user + ":" + secret)));
        user = secret = "";
        busy = true;
        accessSubmit.disabled = true;
        void authenticate(authorization);
        authorization = "";
    });
    for (const view of ["repositories", "config", "logs", "usage"])
        root.querySelector(`[data-view="${view}"]`).addEventListener("click", () => showView(view));
    showView("repositories");
    root.querySelector("[data-cancel]").addEventListener("click", () => { pending = null; dialog.close(); });
    dialog.addEventListener("cancel", () => { pending = null; });
    root.querySelector("[data-confirm]").addEventListener("click", () => {
        if (!pending || busy) return;
        const { action, target, logId } = pending;
        pending = null;
        dialog.close();
        if (action === "schedule/reset") { void saveSchedule(target, true); return; }
        if (action === "run" && (!target.enabled || target.token_state !== "configured" || target.error)) return;
        let body = action === "clear" ? {} : { log_id: logId };
        if (action === "run") {
            if (typeof crypto.randomUUID !== "function") { announce("浏览器不支持安全请求 ID，请使用现代浏览器的 HTTPS 管理页面。"); return; }
            body = { request_id: uncertain.get(target.id) ?? crypto.randomUUID() };
        }
        void mutate(action, target, body);
    });
    addEventListener("hashchange", () => {
        if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
    });
    void authenticate();
}
