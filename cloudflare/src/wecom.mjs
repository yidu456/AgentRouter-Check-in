const WEBHOOK = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]{1,256}$/;
const MAX_RESPONSE_BYTES = 4096;

export function wecomState(env) {
    const value = env?.WECOM_WEBHOOK_URL;
    if (value === undefined || value === "") return "missing";
    return typeof value === "string" && WEBHOOK.test(value) && !/\s/.test(value) ? "configured" : "invalid";
}

function notificationText(target, date, result, source) {
    if (!target || typeof target.repository !== "string"
            || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(target.repository)
            || typeof target.workflow !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(target.workflow)
            || typeof target.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target.ref)
            || /\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(target.ref)
            || /\s/.test(target.repository + target.workflow + target.ref)
            || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
            || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
            || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
            || typeof result !== "string" || !/^(DISPATCH_ACCEPTED|DISPATCH_UNKNOWN|DISPATCH_HTTP_[1-5]\d{2})$/.test(result)
            || /\s/.test(result) || !["automatic", "manual"].includes(source)) return null;
    const status = result === "DISPATCH_ACCEPTED"
        ? "GitHub\u5df2\u53d7\u7406\uff0c\u4e0d\u4ee3\u8868\u7b7e\u5230\u6210\u529f"
        : result === "DISPATCH_UNKNOWN" ? "GitHub\u89e6\u53d1\u7ed3\u679c\u672a\u77e5\uff0c\u4e0d\u4ee3\u8868\u7b7e\u5230\u6210\u529f"
            : "GitHub\u62d2\u7edd\u89e6\u53d1\uff0c\u4e0d\u4ee3\u8868\u7b7e\u5230\u6210\u529f";
    const link = `https://github.com/${target.repository}/actions/workflows/${encodeURIComponent(target.workflow)}`;
    const notifiedAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const text = `Cloudflare\u8c03\u5ea6\u901a\u77e5\n\u4ed3\u5e93: ${target.repository}\n\u5de5\u4f5c\u6d41: ${target.workflow}`
        + `\n\u5206\u652f: ${target.ref}\n\u89e6\u53d1\u6765\u6e90: ${source === "manual" ? "\u624b\u52a8" : "\u81ea\u52a8"}`
        + `\n${source === "manual" ? "\u624b\u52a8\u65e5\u671f" : "\u81ea\u52a8\u65e5\u671f"}: ${date}`
        + `\n\u901a\u77e5\u65f6\u95f4\uff08\u5317\u4eac\u65f6\u95f4\uff09: ${notifiedAt}\n\u89e6\u53d1\u7ed3\u679c: ${result}\n${status}\n${link}`;
    return new TextEncoder().encode(text).byteLength <= 2048 ? text : null;
}

async function readBoundedBody(response) {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (size + value.byteLength > MAX_RESPONSE_BYTES) {
                void reader.cancel().catch(() => {});
                return null;
            }
            bytes.set(value, size);
            size += value.byteLength;
        }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { return null; }
}

export async function sendTriggerNotification(target, date, result, env, source = "automatic") {
    const state = wecomState(env);
    if (state === "missing") return "NOTIFY_NOT_CONFIGURED";
    if (state === "invalid") return "NOTIFY_CONFIG_INVALID";
    const content = notificationText(target, date, result, source);
    if (content === null) return "NOTIFY_FAILED";
    try {
        const response = await fetch(env.WECOM_WEBHOOK_URL, { method: "POST", redirect: "manual",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "text", text: { content } }), signal: AbortSignal.timeout(5000) });
        if (response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            return "NOTIFY_FAILED";
        }
        const payload = await readBoundedBody(response);
        return payload && typeof payload.errcode === "number" && payload.errcode === 0
            ? "NOTIFY_ACCEPTED" : "NOTIFY_FAILED";
    } catch { return "NOTIFY_UNKNOWN"; }
}
