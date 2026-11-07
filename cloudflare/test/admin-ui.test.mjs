import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.mjs";
import { adminClient } from "../src/admin-ui.mjs";
import { runInNewContext } from "node:vm";

const access = "dummy_admin_access_" + "x".repeat(32);

test("static administration client is configured-only and never authenticates or reads objects", async () => {
    for (const token of [undefined, "", "short"]) {
        assert.equal((await worker.fetch(new Request("https://ui.test/admin/client.js"), {
            DEBUG_ACCESS_TOKEN: token })).status, 404);
    }
    const env = { DEBUG_ACCESS_TOKEN: access, GITHUB_TOKEN_A: "github_pat_private_marker",
        SCHEDULES: { idFromName() { assert.fail("Static client must not access objects"); } } };
    const response = await worker.fetch(new Request("https://ui.test/admin/client.js"), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /javascript/);
    for (const header of ["Cache-Control", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options"])
        assert.ok(response.headers.get(header));
    assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
    const script = await response.text();
    assert.ok(!script.includes(access));
    assert.ok(!script.includes(env.GITHUB_TOKEN_A));
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(script));
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|eval\(/.test(script));
    const head = await worker.fetch(new Request("https://ui.test/admin/client.js", { method: "HEAD" }), env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await worker.fetch(new Request("https://ui.test/admin/client.js", { method: "POST" }), env)).status, 405);
});

function bootstrap(hash, handler, customHealth = false) {
    const nodes = new Map();
    const node = (selector) => {
        if (!nodes.has(selector)) nodes.set(selector, { hidden: selector === "#trigger-admin", textContent: "",
            children: [], listeners: {}, dataset: {},
            addEventListener(name, fn) { this.listeners[name] = fn; },
            replaceChildren(...children) { this.children = children; },
            append(...children) { this.children.push(...children); },
            setAttribute() {}, focus() {}, close() {}, showModal() {}, querySelector: node, querySelectorAll() { return []; } });
        return nodes.get(selector);
    };
    const calls = [];
    const listeners = {};
    let sequence = 0;
    const location = { hash, pathname: "/", search: "?token=query-must-not-authenticate" };
    runInNewContext(`(${adminClient.toString()})();`, {
        URLSearchParams, Intl, Date, setTimeout, clearTimeout, location,
        history: { state: null, replaceState(_state, _title, url) {
            calls.push({ erased: true, url }); location.hash = "";
        } },
        document: { querySelector: node, createElement: (tag) => ({ ...node("element-" + tag + "-" + nodes.size) }) },
        addEventListener(name, fn) { listeners[name] = fn; },
        crypto: { randomUUID: () => "00000000-0000-4000-8000-" + String(++sequence).padStart(12, "0") },
        fetch: async (url, options) => {
            assert.equal(location.hash, "", "Fragment must be erased synchronously before fetch");
            if (url === "/health" && !customHealth) return Response.json({config:{state:"valid"},github_tokens:{configured:1,missing:0,invalid:0},wecom:{state:"missing"},storage_binding:{configured:true}});
            calls.push({ url, options }); return handler(url, options);
        },
    });
    return { nodes, node, calls, listeners, location, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("client removes every fragment without using query credentials or fetching anonymously", async () => {
    for (const hash of ["", "#token=short", "#unrelated=private", "#token=" + "x".repeat(129)]) {
        const page = bootstrap(hash, () => assert.fail("No valid fragment token: no admin request"));
        await page.settle();
        assert.equal(page.location.hash, "");
        assert.equal(page.node("#trigger-admin").hidden, true);
        assert.ok(!page.calls.some((call) => call.options));
    }
});

test("fixed token entry authenticates submitted value without storing it or navigating", async () => {
    const page = bootstrap("", async () => Response.json({ status: "OK", targets: [uiTarget] }));
    page.node("[data-access-input]").value = access;
    assert.equal(typeof page.node("[data-access-form]").listeners.submit, "function");
    page.node("[data-access-form]").listeners.submit({ preventDefault() {} });
    await page.settle();
    assert.equal(page.node("[data-access-input]").value, "");
    assert.equal(page.node("#trigger-admin").hidden, false);
    assert.equal(page.calls.find((call) => call.options).options.headers.Authorization, "Bearer " + access);
});

test("authenticated overview displays actual configuration checks", async () => {
    const page = bootstrap("#token=" + access, async (path) => Response.json(path === "/health"
        ? { config: { state: "valid", error: null }, github_tokens: { configured: 2, missing: 1, invalid: 0 },
            wecom: { state: "configured" }, storage_binding: { configured: true } }
        : { status: "OK", targets: [] }), true);
    await page.settle();
    assert.match(page.node("[data-config-summary]").textContent, /JSON.*通过/);
    assert.match(page.node("[data-config-summary]").textContent, /Token.*2.*1/);
});

test("overview failures and invalid configuration never leave a blank or expose targets", async () => {
    for (const state of ["missing", "invalid"]) {
        const page = bootstrap("#token=" + access, async (path) => {
            assert.equal(path, "/health", "Invalid config must stop before listing targets");
            return Response.json({ config: { state, error: { field: "targets[0].ref", code: "TARGET_FIELD" } },
                github_tokens: { configured: 0, missing: 0, invalid: 0 }, wecom: { state: "missing" }, storage_binding: { configured: true } });
        }, true);
        await page.settle();
        assert.equal(page.node("#trigger-admin").hidden, false);
        assert.match(page.node("[data-config-summary]").textContent, /未配置|配置错误/);
        assert.equal(page.node("[data-targets]").children.length, 1);
    }
    for (const mode of ["401", "transport"]) {
        const page = bootstrap("#token=" + access, async () => {
            if (mode === "transport") throw Error("private_response_marker");
            return new Response("private_response_marker", { status: 401 });
        }, true);
        await page.settle();
        assert.equal(page.node("#trigger-admin").hidden, true);
        assert.ok(page.node("[data-access-feedback]").textContent.length > 0);
        assert.ok(!page.node("[data-access-feedback]").textContent.includes("private_response_marker"));
        assert.equal(page.node("[data-access-submit]").disabled, false);
    }
});

test("logout during overview request rejects its late reply before target listing", async () => {
    let finish;
    const page = bootstrap("#token=" + access, () => new Promise(resolve => { finish = resolve; }), true);
    page.node('[data-action="logout"]').listeners.click();
    finish(Response.json({config:{state:"valid"}}));
    await page.settle();
    assert.equal(page.calls.filter(call => call.options).length, 1);
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-config-summary]").textContent, "");
});

test("client verifies fragment Bearer before showing a private view and logout clears it", async () => {
    const page = bootstrap("#token=" + access, async () => Response.json({ status: "OK", targets: [] }));
    await page.settle();
    assert.equal(page.calls[0].erased, true);
    assert.equal(page.calls[1].url, "/api/admin/targets");
    assert.equal(page.calls[1].options.headers.Authorization, "Bearer " + access);
    assert.equal(page.node("#trigger-admin").hidden, false);
    assert.equal(page.node("[data-public-view]").hidden, true);
    page.node('[data-action="logout"]').listeners.click();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-public-view]").hidden, false);
    assert.equal(page.node("[data-targets]").children.length, 0);
});

test("unauthorized bootstrap and expired auth leave no private DOM or raw error detail", async () => {
    let authorized = false;
    const page = bootstrap("#token=" + access, async () => authorized
        ? Response.json({ status: "OK", targets: [] })
        : Response.json({ status: "UNAUTHORIZED", detail: "private_exception_marker" }, { status: 401 }));
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-targets]").children.length, 0);
    assert.match(page.node("[data-access-feedback]").textContent, /访问|验证/);
    assert.equal(page.node("[data-access-submit]").disabled, false, "Failed auth must permit another token submission");
    assert.ok(!page.node("[data-access-feedback]").textContent.includes("private_exception_marker"));
    authorized = true;
    const expired = bootstrap("#token=" + access, async () => authorized
        ? Response.json({ status: "OK", targets: [] }) : Response.json({ status: "UNAUTHORIZED" }, { status: 401 }));
    await expired.settle();
    expired.node("[data-targets]").children.push("private-repository-sentinel");
    authorized = false;
    expired.node('[data-action="refresh"]').listeners.click();
    await expired.settle();
    assert.equal(expired.node("#trigger-admin").hidden, true);
    assert.equal(expired.node("[data-targets]").children.length, 0);
});

test("logout invalidates an in-flight listing so its late response cannot show private state", async () => {
    let complete;
    const page = bootstrap("#token=" + access, () => new Promise((resolve) => { complete = resolve; }));
    await page.settle();
    page.node('[data-action="logout"]').listeners.click();
    complete(Response.json({ status: "OK", targets: [] }));
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-targets]").children.length, 0);
});

test("HTTP 401 clears the verified view even when its response is not JSON", async () => {
    let expired = false;
    const page = bootstrap("#token=" + access, async () => expired ? new Response("private-error-marker", { status: 401 })
        : Response.json({ status: "OK", targets: [] }));
    await page.settle();
    page.node("[data-targets]").children.push("private-repository-sentinel");
    expired = true;
    page.node('[data-action="refresh"]').listeners.click();
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-targets]").children.length, 0);
    assert.ok(!page.node("[data-access-feedback]").textContent.includes("private-error-marker"));
});

const uiTarget = { id: "primary", repository: "fixture/team", workflow: "Checkin.yml", ref: "main",
    enabled: true, token_state: "configured", next_run: null, history: [], error: null };
function runButton(page) {
    const visit = (item) => item.dataset?.action === "run" ? item : item.children?.map(visit).find(Boolean);
    return page.node("[data-targets]").children.map(visit).find(Boolean);
}
async function confirmRun(page) {
    runButton(page).listeners.click();
    page.node("[data-confirm]").listeners.click();
    await page.settle();
}

test("manual retry preserves UUID after possibly-dispatched 503 responses and intervening refresh", async (t) => {
    for (const status of ["STORAGE_UNAVAILABLE", "STATE_INVALID", "UNKNOWN_FIXTURE_CODE"]) {
        await t.test(status, async () => {
            const ids = [];
            const page = bootstrap("#token=" + access, async (url, options) => {
                if (options.method === "GET") return Response.json({ status: "OK", targets: [uiTarget] });
                const { request_id } = JSON.parse(options.body);
                ids.push(request_id);
                // Model an accepted dispatch whose following persistence/response fails.
                if (ids.length === 1) return Response.json({ status }, { status: 503 });
                return Response.json({ status: "DISPATCH_ACCEPTED", cached: true, record: {
                    id: request_id, at: Date.now(), source: "manual", result: "DISPATCH_ACCEPTED", notification: "NOTIFY_ACCEPTED" } });
            });
            await page.settle();
            await confirmRun(page);
            assert.equal(runButton(page).textContent, "重试原请求");
            assert.match(page.node("[data-feedback]").textContent, /原请求|同一请求/);
            page.node('[data-action="refresh"]').listeners.click();
            await page.settle();
            assert.equal(runButton(page).textContent, "重试原请求");
            await confirmRun(page);
            assert.equal(ids.length, 2);
            assert.equal(ids[1], ids[0], "A retry must not create a new dispatch UUID");
            assert.equal(runButton(page).textContent, "手动运行");
        });
    }
});

test("explicit pre-dispatch rejection discards UUID and permits a later new manual request", async () => {
    const ids = [];
    const page = bootstrap("#token=" + access, async (_url, options) => {
        if (options.method === "GET") return Response.json({ status: "OK", targets: [uiTarget] });
        const { request_id } = JSON.parse(options.body);
        ids.push(request_id);
        return Response.json({ status: "COOLDOWN" }, { status: 429 });
    });
    await page.settle();
    await confirmRun(page);
    assert.equal(runButton(page).textContent, "手动运行");
    await confirmRun(page);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[1], ids[0]);
});

test("hash-only management navigation consumes token before authenticating an already-open public page", async () => {
    const page = bootstrap("", async () => Response.json({ status: "OK", targets: [] }));
    await page.settle();
    assert.equal(page.calls.length, 0);
    assert.equal(typeof page.listeners.hashchange, "function");
    page.location.hash = "#token=" + access;
    page.listeners.hashchange();
    assert.equal(page.location.hash, "");
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, false);
    assert.equal(page.calls.at(-1).options.headers.Authorization, "Bearer " + access);
    const requests = page.calls.filter((call) => call.options).length;
    page.location.hash = "#unrelated=anchor";
    page.listeners.hashchange();
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, false);
    assert.equal(page.calls.filter((call) => call.options).length, requests);
});

test("hash token replacement clears prior session and rejects its late authenticated listing", async () => {
    let oldReply;
    let request = 0;
    const page = bootstrap("#token=" + access, async () => ++request === 1
        ? new Promise((resolve) => { oldReply = resolve; }) : Response.json({ status: "OK", targets: [] }));
    await page.settle();
    assert.equal(typeof page.listeners.hashchange, "function");
    page.location.hash = "#token=" + "y".repeat(32);
    page.listeners.hashchange();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.location.hash, "");
    await page.settle();
    oldReply(Response.json({ status: "OK", targets: [uiTarget] }));
    await page.settle();
    assert.equal(page.calls.filter((call) => call.options).at(-1).options.headers.Authorization, "Bearer " + "y".repeat(32));
    assert.equal(page.node("[data-target-count]").textContent, "0 个目标 · 0 个开启");
    page.location.hash = "#token=invalid";
    page.listeners.hashchange();
    assert.equal(page.location.hash, "");
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-targets]").children.length, 0);
});
