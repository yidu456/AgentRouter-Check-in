import assert from "node:assert/strict";
import { test } from "node:test";
import { wecomState, sendTriggerNotification } from "../src/wecom.mjs";

const webhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=dummy_private_key";
const env = { WECOM_WEBHOOK_URL: webhook, GITHUB_TOKEN_A: "github_private_token" };
const target = { id: "github_a", repository: "owner/AgentRouter-Check-in", workflow: "Checkin.yml",
    ref: "dev-plus", token_secret: "GITHUB_TOKEN_A", enabled: true };
const date = "2026-11-07";

function httpFixture(t, response = () => new Response('{"errcode":0,"errmsg":"ok"}')) {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({ url, options });
        return response(url, options);
    });
    return requests;
}

test("webhook state exposes only presence and strict canonical validity without HTTP", (t) => {
    const requests = httpFixture(t);
    assert.equal(wecomState({}), "missing");
    assert.equal(wecomState({ WECOM_WEBHOOK_URL: "" }), "missing");
    assert.equal(wecomState(env), "configured");
    for (const value of [null, 123, {}, "private", " ", ` ${webhook}`, `${webhook}\n`,
        webhook.replace("https:", "http:"), webhook.replace("qyapi.weixin.qq.com", "evil.test"),
        webhook.replace("qyapi.weixin.qq.com", "qyapi.weixin.qq.com.evil.test"),
        webhook.replace("qyapi.weixin.qq.com", "QYAPI.WEIXIN.QQ.COM"),
        webhook.replace("qyapi.weixin.qq.com", "qyapi.weixin.qq.com:443"),
        webhook.replace("qyapi.weixin.qq.com", "user:private@qyapi.weixin.qq.com"),
        webhook.replace("/cgi-bin/", "/unused/../cgi-bin/"),
        webhook.replace("/webhook/send", "/webhook/%73end"),
        webhook.replace("?key=", "?%6bey="), webhook.replace("dummy_private_key", "%64ummy"),
        webhook.replace("dummy_private_key", ""), `${webhook}&key=second`, `${webhook}&extra=private`,
        `${webhook}#private`, `${webhook}/`, `${webhook}?other`,
        webhook.replace("dummy_private_key", "a".repeat(257))]) {
        assert.equal(wecomState({ WECOM_WEBHOOK_URL: value }), "invalid");
    }
    assert.equal(requests.length, 0);
});

test("unconfigured and malformed private secrets skip bot HTTP", async (t) => {
    const requests = httpFixture(t);
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", {}), "NOTIFY_NOT_CONFIGURED");
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED",
        { WECOM_WEBHOOK_URL: "private_invalid_url" }), "NOTIFY_CONFIG_INVALID");
    assert.equal(requests.length, 0);
});

test("accepted dispatch sends one text notification with truthful status and general workflow link", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-11-07T17:02:03Z"));
    const requests = httpFixture(t);
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_ACCEPTED");
    assert.equal(requests.length, 1);
    const { url, options } = requests[0];
    assert.equal(url, webhook);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options.headers), ["Content-Type"]);
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload), ["msgtype", "text"]);
    assert.equal(payload.msgtype, "text");
    assert.deepEqual(Object.keys(payload.text), ["content"]);
    for (const value of [target.repository, target.workflow, target.ref, date, "DISPATCH_ACCEPTED",
        "Cloudflare\u8c03\u5ea6\u901a\u77e5", "\u4ed3\u5e93", "\u5de5\u4f5c\u6d41", "\u5206\u652f", "\u81ea\u52a8\u65e5\u671f",
        "\u901a\u77e5\u65f6\u95f4\uff08\u5317\u4eac\u65f6\u95f4\uff09: 2026-11-08 01:02:03", "\u89e6\u53d1\u7ed3\u679c",
        "\u0047\u0069\u0074\u0048\u0075\u0062\u5df2\u53d7\u7406\uff0c\u4e0d\u4ee3\u8868\u7b7e\u5230\u6210\u529f",
        "https://github.com/owner/AgentRouter-Check-in/actions/workflows/Checkin.yml"]) {
        assert.ok(payload.text.content.includes(value));
    }
    assert.ok(Buffer.byteLength(payload.text.content, "utf8") <= 2048);
    for (const value of ["dummy_private_key", "github_private_token", "GITHUB_TOKEN_A", "/actions/runs/", "@all",
        "Repository:", "Workflow:", "Ref:", "Date (Asia/Shanghai):", "Result:"])
        assert.equal(payload.text.content.includes(value), false);
});

test("rejected and unknown dispatch messages do not claim GitHub acceptance or sign-in success", async (t) => {
    const requests = httpFixture(t);
    for (const result of ["DISPATCH_HTTP_401", "DISPATCH_HTTP_302", "DISPATCH_UNKNOWN"]) {
        assert.equal(await sendTriggerNotification(target, date, result, env), "NOTIFY_ACCEPTED");
        const content = JSON.parse(requests.at(-1).options.body).text.content;
        assert.ok(content.includes(result));
        assert.equal(content.includes("\u0047\u0069\u0074\u0048\u0075\u0062\u5df2\u53d7\u7406"), false);
        assert.ok(content.includes(result === "DISPATCH_UNKNOWN" ? "\u672a\u77e5" : "\u62d2\u7edd"));
    }
    assert.equal(requests.length, 3);
});

test("maximum valid target fits one UTF-8 text message", async (t) => {
    const requests = httpFixture(t);
    const maximum = { ...target, repository: `${"o".repeat(100)}/${"r".repeat(100)}`,
        workflow: `${"w".repeat(100)}.yaml`, ref: "r".repeat(200) };
    assert.equal(await sendTriggerNotification(maximum, date, "DISPATCH_ACCEPTED", env), "NOTIFY_ACCEPTED");
    assert.equal(requests.length, 1);
    assert.ok(Buffer.byteLength(JSON.parse(requests[0].options.body).text.content, "utf8") <= 2048);
});

test("invalid or unbounded message fields fail closed without notification or secret echo", async (t) => {
    const requests = httpFixture(t);
    for (const [value, day, result] of [
        [{ ...target, repository: "evil.test/private".repeat(200) }, date, "DISPATCH_ACCEPTED"],
        [{ ...target, repository: "owner/repo\nprivate" }, date, "DISPATCH_ACCEPTED"],
        [{ ...target, workflow: "../private.yml" }, date, "DISPATCH_ACCEPTED"],
        [{ ...target, ref: "main\nprivate" }, date, "DISPATCH_ACCEPTED"],
        [{ ...target, ref: "../private" }, date, "DISPATCH_ACCEPTED"],
        [{ ...target, ref: "refs/heads/private.lock" }, date, "DISPATCH_ACCEPTED"],
        [target, "2026-02-30", "DISPATCH_ACCEPTED"], [target, "private_date", "DISPATCH_ACCEPTED"],
        [target, date, "DISPATCH_HTTP_999"], [target, date, "private_result"],
        [target, date, "DISPATCH_ACCEPTED\nprivate"], [null, date, "DISPATCH_ACCEPTED"]]) {
        assert.equal(await sendTriggerNotification(value, day, result, env), "NOTIFY_FAILED");
    }
    assert.equal(requests.length, 0);
});

test("only HTTP 200 with numeric errcode zero is bot acceptance; failures are never retried", async (t) => {
    const responses = [new Response('{"errcode":0,"errmsg":"ok"}', { status: 200 }),
        new Response('{"errcode":0}', { status: 401 }), new Response('{"errcode":0}', { status: 302 }),
        new Response(null, { status: 204 }), new Response('{"errcode":40013,"errmsg":"private_server_error"}'),
        new Response('{"errcode":false}'), new Response('{"errcode":"0"}'), new Response('{}'),
        new Response('null'), new Response('[]'), new Response('private_bad_json')];
    const requests = httpFixture(t, () => responses.shift());
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_ACCEPTED");
    for (let i = 0; i < 10; i++)
        assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_FAILED");
    assert.equal(requests.length, 11);
    assert.ok(requests.every(({ url, options }) => url === webhook && options.redirect === "manual"));
});

test("bot JSON is read as a bounded stream and oversize bodies are cancelled", async (t) => {
    let cancellations = 0;
    const requests = httpFixture(t, () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(4097))); },
        cancel() { cancellations++; },
    })));
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_FAILED");
    assert.equal(cancellations, 1);
    assert.equal(requests.length, 1);
});

test("bounded multichunk JSON accepts exactly 4096 bytes and rejects one more byte", async (t) => {
    const bodies = [`{"errcode":0,"padding":"${"x".repeat(4070)}"}`,
        `{"errcode":0,"padding":"${"x".repeat(4071)}"}`];
    assert.equal(Buffer.byteLength(bodies[0]), 4096);
    assert.equal(Buffer.byteLength(bodies[1]), 4097);
    const requests = httpFixture(t, () => {
        const body = bodies.shift();
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(body.slice(0, 2000)));
            controller.enqueue(new TextEncoder().encode(body.slice(2000)));
            controller.close();
        } }));
    });
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_ACCEPTED");
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_FAILED");
    assert.equal(requests.length, 2);
});

test("response limit counts UTF-8 bytes rather than characters and invalid UTF-8 fails closed", async (t) => {
    const oversized = `{"errcode":0,"padding":"${"\u4e2d".repeat(1360)}"}`;
    assert.ok(oversized.length < 4096);
    assert.ok(Buffer.byteLength(oversized) > 4096);
    const bodies = [oversized, Uint8Array.from([0xff, 0xfe, 0xff])];
    const requests = httpFixture(t, () => new Response(bodies.shift()));
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_FAILED");
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_FAILED");
    assert.equal(requests.length, 2);
});

test("fetch and body exceptions stay unknown without logs, fallback or retries", async (t) => {
    const logs = [];
    for (const method of ["log", "warn", "error"])
        t.mock.method(console, method, (...args) => logs.push(args));
    let mode = "fetch";
    const requests = httpFixture(t, () => {
        if (mode === "fetch") throw new Error(`private_exception ${webhook}`);
        return new Response(new ReadableStream({ start(controller) {
            controller.error(new Error(`private_body ${webhook}`));
        } }));
    });
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_UNKNOWN");
    mode = "body";
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_UNKNOWN");
    assert.equal(requests.length, 2);
    assert.deepEqual(logs, []);
});

test("bot timeout uses a five-second abort signal and never retries unknown delivery", async (t) => {
    const controller = new AbortController();
    t.mock.method(AbortSignal, "timeout", (milliseconds) => {
        assert.equal(milliseconds, 5000);
        queueMicrotask(() => controller.abort(new DOMException("private_timeout", "TimeoutError")));
        return controller.signal;
    });
    const requests = httpFixture(t, (_url, options) => new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env), "NOTIFY_UNKNOWN");
    assert.equal(requests.length, 1);
});

test("notification distinguishes manual source and rejects arbitrary source without bot HTTP", async (t) => {
    const requests = httpFixture(t);
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env, "manual"), "NOTIFY_ACCEPTED");
    const content = JSON.parse(requests[0].options.body).text.content;
    assert.ok(content.includes("\u624b\u52a8"));
    assert.equal(content.includes("\u81ea\u52a8\u65e5\u671f"), false);
    assert.ok(content.includes("\u0047\u0069\u0074\u0048\u0075\u0062\u5df2\u53d7\u7406\uff0c\u4e0d\u4ee3\u8868\u7b7e\u5230\u6210\u529f"));
    assert.equal(await sendTriggerNotification(target, date, "DISPATCH_ACCEPTED", env, "private_source"), "NOTIFY_FAILED");
    assert.equal(requests.length, 1);
});
