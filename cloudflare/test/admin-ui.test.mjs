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

const sessionData = () => ({ status: "AUTHENTICATED", expires_at: new Date(Date.now() + 43_200_000).toISOString(),
    csrf_token: "dummy_csrf_" + "x".repeat(32) });

function bootstrap(autoLogin, handler, customHealth = false, hash = "", sessionHandler) {
    const nodes = new Map();
    const node = (selector) => {
        if (!nodes.has(selector)) nodes.set(selector, { hidden: selector === "#trigger-admin", textContent: "",
            children: [], listeners: {}, dataset: {}, attributes: {},
            addEventListener(name, fn) { this.listeners[name] = fn; },
            replaceChildren(...children) { this.children = children; },
            append(...children) { this.children.push(...children); },
            setAttribute(name, value) { this.attributes[name] = value; }, focus() {}, close() {}, showModal() {}, querySelector: node, querySelectorAll() { return []; } });
        return nodes.get(selector);
    };
    const calls = [];
    const listeners = {};
    let sequence = 0;
    const location = { hash, origin: "https://ui.test", pathname: "/", search: "?token=query-must-not-authenticate" };
    runInNewContext(`(${adminClient.toString()})();`, {
        URLSearchParams, Intl, Date, TextEncoder, btoa, setTimeout, clearTimeout, location,
        history: { state: null, replaceState(_state, _title, url) {
            calls.push({ erased: true, url }); location.hash = "";
        } },
        document: { querySelector: node, createElement: (tag) => ({ ...node("element-" + tag + "-" + nodes.size), tagName: tag.toUpperCase() }) },
        addEventListener(name, fn) { listeners[name] = fn; },
        crypto: { randomUUID: () => "00000000-0000-4000-8000-" + String(++sequence).padStart(12, "0") },
        fetch: async (url, options) => {
            assert.equal(location.hash, "", "Fragment must be erased synchronously before fetch");
            if (url.startsWith("/api/admin/session")) {
                calls.push({ url, options });
                if (sessionHandler) return sessionHandler(url, options);
                return url === "/api/admin/session" ? Response.json({ status: "UNAUTHORIZED" }, { status: 401 })
                    : url.endsWith("/logout") ? Response.json({ status: "SIGNED_OUT" }) : Response.json(sessionData());
            }
            if (url === "/health" && !customHealth) return Response.json({config:{state:"valid"},github_tokens:{configured:1,missing:0,invalid:0},wecom:{state:"missing"},storage_binding:{configured:true}});
            calls.push({ url, options }); return handler(url, options);
        },
    });
    const login = (user = "test-admin", secret = "dummy-long-secret-for-tests") => {
        node("[data-access-username]").value = user;
        node("[data-access-input]").value = secret;
        node("[data-access-form]").listeners.submit({ preventDefault() {} });
    };
    if (autoLogin) login();
    return { nodes, node, calls, listeners, location, login, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("client removes every fragment before anonymous session bootstrap without using query credentials", async () => {
    for (const hash of ["", "#token=short", "#unrelated=private", "#token=" + "x".repeat(129)]) {
        const page = bootstrap(false, () => assert.fail("Fragments must never authenticate"), false, hash);
        await page.settle();
        assert.equal(page.location.hash, "");
        assert.equal(page.node("#trigger-admin").hidden, true);
        const requests = page.calls.filter(call => call.options);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, "/api/admin/session");
        assert.equal(requests[0].options.credentials, "same-origin");
        assert.equal(requests[0].options.headers.Authorization, undefined);
    }
});

test("login exchanges Basic once then clears both inputs and uses the cookie for private reads", async () => {
    const page = bootstrap(false, async () => Response.json({ status: "OK", targets: [uiTarget] }));
    page.node("[data-access-username]").value = "test-admin";
    page.node("[data-access-input]").value = "dummy-long-secret-for-tests";
    assert.equal(typeof page.node("[data-access-form]").listeners.submit, "function");
    page.node("[data-access-form]").listeners.submit({ preventDefault() {} });
    await page.settle();
    assert.equal(page.node("[data-access-input]").value, "");
    assert.equal(page.node("[data-access-username]").value, "");
    assert.equal(page.node("#trigger-admin").hidden, false);
    const login = page.calls.find((call) => call.url.endsWith("/login"));
    assert.equal(login.options.headers.Authorization, "Basic " + Buffer.from("test-admin:dummy-long-secret-for-tests").toString("base64"));
    assert.equal(login.options.headers.Origin, "https://ui.test");
    assert.equal(login.options.body, "{}");
    assert.ok(page.calls.filter(call => !call.url.endsWith("/login")).every(call => !call.options.headers.Authorization));
});

test("authenticated overview displays actual configuration checks", async () => {
    const page = bootstrap(true, async (path) => Response.json(path === "/health"
        ? { config: { state: "valid", error: null }, github_tokens: { configured: 2, missing: 1, invalid: 0 },
            wecom: { state: "configured" }, storage_binding: { configured: true } }
        : { status: "OK", targets: [] }), true);
    await page.settle();
    assert.match(page.node("[data-config-summary]").textContent, /JSON.*通过/);
    assert.match(page.node("[data-config-summary]").textContent, /Token.*2.*1/);
});

test("overview failures and invalid configuration never leave a blank or expose targets", async () => {
    for (const state of ["missing", "invalid"]) {
        const page = bootstrap(true, async (path) => {
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
        const page = bootstrap(true, async () => {
            if (mode === "transport") throw Error("private_response_marker");
            return new Response("private_response_marker", { status: 401 });
        }, true);
        await page.settle();
        assert.equal(page.node("#trigger-admin").hidden, mode === "401");
        const message = page.node(mode === "401" ? "[data-access-feedback]" : "[data-feedback]").textContent;
        assert.ok(message.length > 0);
        assert.ok(!message.includes("private_response_marker"));
        assert.equal(page.node("[data-access-submit]").disabled, false);
    }
});

test("logout during overview request rejects its late reply before target listing", async () => {
    let finish;
    const page = bootstrap(true, () => new Promise(resolve => { finish = resolve; }), true);
    await page.settle();
    page.node('[data-action="logout"]').listeners.click();
    finish(Response.json({config:{state:"valid"}}));
    await page.settle();
    assert.ok(!page.calls.some(call => call.url === "/api/admin/targets"));
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-config-summary]").textContent, "");
});

test("server logout revokes the cookie before private state is cleared", async () => {
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [] }));
    await page.settle();
    assert.equal(page.calls[0].url, "/api/admin/session");
    assert.equal(page.calls.find(call => call.url === "/api/admin/targets").options.headers.Authorization, undefined);
    assert.equal(page.node("#trigger-admin").hidden, false);
    assert.equal(page.node("[data-public-view]").hidden, true);
    page.node('[data-action="logout"]').listeners.click();
    await page.settle();
    const revoke = page.calls.find(call => call.url.endsWith("/logout"));
    assert.equal(revoke.options.headers["X-CSRF-Token"], sessionData().csrf_token);
    assert.equal(revoke.options.headers.Origin, "https://ui.test");
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-public-view]").hidden, false);
    assert.equal(page.node("[data-targets]").children.length, 0);
});

test("unauthorized bootstrap and expired auth leave no private DOM or raw error detail", async () => {
    let authorized = false;
    const page = bootstrap(true, async () => authorized
        ? Response.json({ status: "OK", targets: [] })
        : Response.json({ status: "UNAUTHORIZED", detail: "private_exception_marker" }, { status: 401 }));
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-targets]").children.length, 0);
    assert.match(page.node("[data-access-feedback]").textContent, /访问|验证/);
    assert.equal(page.node("[data-access-submit]").disabled, false, "Failed auth must permit another token submission");
    assert.ok(!page.node("[data-access-feedback]").textContent.includes("private_exception_marker"));
    authorized = true;
    const expired = bootstrap(true, async () => authorized
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
    const page = bootstrap(true, () => new Promise((resolve) => { complete = resolve; }));
    await page.settle();
    page.node('[data-action="logout"]').listeners.click();
    complete(Response.json({ status: "OK", targets: [] }));
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-targets]").children.length, 0);
});

test("HTTP 401 clears the verified view even when its response is not JSON", async () => {
    let expired = false;
    const page = bootstrap(true, async () => expired ? new Response("private-error-marker", { status: 401 })
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
            const page = bootstrap(true, async (url, options) => {
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
    const page = bootstrap(true, async (_url, options) => {
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

test("fragments never log in or replace an existing independent login", async () => {
    const page = bootstrap(false, async () => Response.json({ status: "OK", targets: [] }), false, "#token=" + access);
    await page.settle();
    assert.equal(page.location.hash, "");
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.deepEqual(page.calls.filter(call => call.options).map(call => call.url), ["/api/admin/session"]);
});

function textTree(item) { return [item.textContent, ...(item.children ?? []).map(textTree)].join(" "); }
function hasAction(item, action) { return item.dataset?.action === action || item.children?.some(child => hasAction(child, action)); }

test("three navigation sections separate operations diagnostics and repository-grouped history", async () => {
    const second = { ...uiTarget, id: "secondary", ref: "dev" };
    const third = { ...uiTarget, id: "other", repository: "different/repo", error: "STORAGE_UNAVAILABLE" };
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [uiTarget, second, third] }));
    await page.settle();
    assert.equal(page.node('[data-section="repositories"]').hidden, false);
    assert.equal(page.node('[data-section="config"]').hidden, true);
    assert.equal(page.node('[data-section="logs"]').hidden, true);
    assert.ok(!hasAction(page.node("[data-targets]"), "clear"));
    assert.ok(!hasAction(page.node("[data-targets]"), "delete"));
    const groups = page.node("[data-logs]").children;
    assert.equal(groups.length, 2, "Two targets in same repository share a group");
    assert.match(textTree(groups[0]), /main.*dev/);
    assert.match(textTree(groups[1]), /存储.*不可用/);
    assert.ok(!hasAction(page.node("[data-logs]"), "run"));
    page.node('[data-view="logs"]').listeners.click();
    assert.equal(page.node('[data-section="repositories"]').hidden, true);
    assert.equal(page.node('[data-section="logs"]').hidden, false);
});

test("invalid JSON selects configuration section and shows safe repair advice", async () => {
    const page = bootstrap(true, async () => Response.json({ config: { state: "invalid", error: {
        field: "targets[0].ref", code: "TARGET_FIELD" } }, github_tokens: {}, wecom: {}, storage_binding: {} }), true);
    await page.settle();
    assert.equal(page.node('[data-section="config"]').hidden, false);
    assert.match(page.node("[data-config-summary]").textContent, /targets\[0\].ref/);
    assert.match(page.node("[data-config-advice]").textContent, /分支|字段/);
});

test("failed refresh removes stale targets and history with an explicit unavailable state", async () => {
    let failed = false;
    const page = bootstrap(true, async () => {
        if (failed) throw new Error("private_marker");
        return Response.json({ status: "OK", targets: [uiTarget] });
    });
    await page.settle();
    failed = true;
    page.node('[data-action="refresh"]').listeners.click();
    await page.settle();
    assert.ok(!textTree(page.node("[data-targets]")).includes(uiTarget.repository));
    assert.match(textTree(page.node("[data-logs]")), /失败|不可用|未知/);
});

test("a valid cookie restores the verified private page on reload without credentials", async () => {
    const page = bootstrap(false, async () => Response.json({ status: "OK", targets: [uiTarget] }), false, "",
        async (url) => { assert.equal(url, "/api/admin/session"); return Response.json(sessionData()); });
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, false);
    assert.match(textTree(page.node("[data-targets]")), /fixture\/team/);
    assert.ok(!page.calls.some(call => call.url.endsWith("/login")));
    assert.ok(page.calls.every(call => call.options.credentials === "same-origin" && !call.options.headers.Authorization));
});

test("failed revocation clears the local view but explicitly keeps server logout unknown", async () => {
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [uiTarget] }), false, "",
        async (url) => url === "/api/admin/session" ? Response.json({ status: "UNAUTHORIZED" }, { status: 401 })
            : url.endsWith("/login") ? Response.json(sessionData()) : new Response("private_revoke_marker", { status: 503 }));
    await page.settle();
    page.node('[data-action="logout"]').listeners.click();
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.match(page.node("[data-access-feedback]").textContent, /服务端.*未确认|服务端.*未知/);
    assert.ok(!page.node("[data-access-feedback]").textContent.includes("private_revoke_marker"));
    assert.ok(!/已退出管理/.test(page.node("[data-access-feedback]").textContent));
});

test("pagehide never revokes a reload-persistent session", async () => {
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [] }));
    await page.settle();
    page.listeners.pagehide?.();
    await page.settle();
    assert.ok(!page.calls.some(call => call.url.endsWith("/logout")));
});

test("post-login mutations carry memory CSRF and same-origin cookie without Basic", async () => {
    const page = bootstrap(true, async (_url, options) => options.method === "GET"
        ? Response.json({ status: "OK", targets: [uiTarget] })
        : Response.json({ status: "COOLDOWN" }, { status: 429 }));
    await page.settle();
    await confirmRun(page);
    const mutation = page.calls.find(call => call.url.endsWith("/run"));
    assert.equal(mutation.options.headers["X-CSRF-Token"], sessionData().csrf_token);
    assert.equal(mutation.options.headers.Origin, "https://ui.test");
    assert.equal(mutation.options.headers.Authorization, undefined);
    assert.equal(mutation.options.credentials, "same-origin");
});

test("late bootstrap cannot overwrite a newer login", async () => {
    let complete;
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [uiTarget] }), false, "",
        async (url) => url === "/api/admin/session" ? new Promise(resolve => { complete = resolve; }) : Response.json(sessionData()));
    await page.settle();
    complete(Response.json({ status: "UNAUTHORIZED" }, { status: 401 }));
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, false);
});

const inspectedItem = { index: 0, id: "primary", repository: "fixture/team", workflow: "Checkin.yml", ref: "main",
    token_secret: "GITHUB_TOKEN_A", enabled: true, token_state: "configured",
    schedule: { mode: "fixed", times: ["08:30", "13:00", "20:30"] }, error: null };
const visualHealth = (state = "valid", items = [inspectedItem], error = null) => ({
    config: { state, items, error }, github_tokens: { configured: 1, missing: 0, invalid: 0, verified: false },
    storage_binding: { configured: true }, wecom: { state: "configured", verified: false },
});

test("visual configuration renders four named readiness checks and safe fixed schedule badges", async () => {
    const page = bootstrap(true, async url => Response.json(url === "/health" ? visualHealth()
        : { status: "OK", targets: [] }), true);
    await page.settle();
    const panels = page.node("[data-readiness]").children;
    assert.equal(panels.length, 4);
    for (const [index, label] of ["JSON 配置", "GitHub 凭据", "数据库绑定", "企业微信"].entries()) {
        assert.equal(panels[index].tagName, "ARTICLE");
        assert.match(textTree(panels[index]), new RegExp(label));
        assert.ok(panels[index].attributes["aria-label"]);
    }
    assert.match(textTree(panels[1]), /已填写.*权限未验证/);
    assert.match(textTree(panels[2]), /已绑定.*健康未验证/);
    assert.match(textTree(panels[3]), /已填写.*送达未验证/);
    const table = page.node("[data-config-items]");
    assert.match(textTree(table), /fixture\/team.*固定.*3.*08:30.*13:00.*20:30.*GITHUB_TOKEN_A/);
    assert.ok(!hasAction(table, "run") && !hasAction(table, "toggle"));
});

test("partly invalid config shows valid fields only highlights the target and never lists runnable targets", async () => {
    const item = { ...inspectedItem, index: 1, schedule: null, ref: null,
        error: { field: "targets[1].schedule.count", code: "SCHEDULE_COUNT" } };
    const page = bootstrap(true, async url => {
        assert.equal(url, "/health");
        return Response.json(visualHealth("invalid", [inspectedItem, item], item.error));
    }, true);
    await page.settle();
    const text = textTree(page.node("[data-config-items]"));
    assert.match(text, /第 2 个目标.*schedule.count/);
    assert.match(text, /fixture\/team/);
    assert.match(text, /未通过|—/);
    assert.match(page.node("[data-config-advice]").textContent, /1.*24.*整数/);
    assert.ok(!hasAction(page.node("[data-config-items]"), "run"));
});

test("broken JSON presents unknown targets and folded safe diagnostics rather than a zero-target claim", async () => {
    const error = { field: "TRIGGER_CONFIG", code: "JSON_SYNTAX" };
    const page = bootstrap(true, async () => Response.json(visualHealth("invalid", [], error)), true);
    await page.settle();
    assert.match(textTree(page.node("[data-config-items]")), /无法解析|无法确认/);
    assert.ok(!/0 个目标/.test(textTree(page.node("[data-config-items]"))));
    assert.match(page.node("[data-config-diagnostic]").textContent, /TRIGGER_CONFIG.*JSON_SYNTAX/s);
    assert.equal(page.node("[data-config-details]").open, false);
});

test("untrusted diagnostic values are never printed even when a health response is malformed", async () => {
    const page = bootstrap(true, async () => Response.json(visualHealth("invalid", [], {
        field: "private_bad_field_marker", code: "private_bad_code_marker" })), true);
    await page.settle();
    const text = ["[data-config-summary]", "[data-config-advice]", "[data-config-items]", "[data-config-diagnostic]"]
        .map(selector => textTree(page.node(selector))).join(" ");
    assert.ok(!text.includes("private_bad_field_marker"));
    assert.ok(!text.includes("private_bad_code_marker"));
});

test("repository page displays saved slots and distinguishes accepted unknown and skipped attempts", async () => {
    const target = { ...uiTarget, schedule: inspectedItem.schedule, schedule_date: "2026-11-08",
        slots: [{ at: "2026-11-08T00:30:00.000Z", attempted: true, result: "DISPATCH_ACCEPTED" },
            { at: "2026-11-08T05:00:00.000Z", attempted: true, result: "DISPATCH_UNKNOWN" },
            { at: "2026-11-08T12:30:00.000Z", attempted: true, result: "MISSED_DATE" }] };
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [target] }));
    await page.settle();
    const text = textTree(page.node("[data-targets]"));
    assert.match(text, /已保存时段.*08:30.*GitHub 已受理.*13:00.*结果未知.*20:30.*已跳过/);
    assert.ok(!/已跳过.*成功触发/.test(text));
});

test("malformed optional slot data fails closed instead of echoing unchecked status", async () => {
    const target = { ...uiTarget, slots: [{ at: "2026-11-08T00:30:00.000Z", attempted: true,
        result: "private_slot_marker" }] };
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [target] }));
    await page.settle();
    const text = textTree(page.node("[data-targets]"));
    assert.ok(!text.includes("private_slot_marker"));
    assert.ok(!text.includes(uiTarget.repository));
    assert.match(text, /不可识别|读取失败/);
});

test("random count exceeding its window gets specific safe capacity repair advice", async () => {
    const error = { field: "targets[0].schedule.count", code: "SCHEDULE_CAPACITY" };
    const page = bootstrap(true, async () => Response.json(visualHealth("invalid", [
        { ...inspectedItem, schedule: null, error }], error)), true);
    await page.settle();
    assert.match(page.node("[data-config-advice]").textContent, /窗口.*分钟|分钟.*窗口/);
    assert.match(page.node("[data-config-diagnostic]").textContent, /SCHEDULE_CAPACITY/);
});

test("random inspection displays count and window without claiming sampled times", async () => {
    const item = { ...inspectedItem, schedule: { mode: "random", count: 3, window: { start: "09:00", end: "22:00" } } };
    const page = bootstrap(true, async url => Response.json(url === "/health" ? visualHealth("valid", [item])
        : { status: "OK", targets: [] }), true);
    await page.settle();
    assert.match(textTree(page.node("[data-config-items]")), /随机.*3 次\/天.*09:00～22:00/);
    assert.ok(!textTree(page.node("[data-config-items]")).includes("已保存时段"));
});

test("logout keeps the current view until revocation completes and ignores late private reads", async () => {
    let revoke;
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [uiTarget] }), false, "",
        async (url) => url === "/api/admin/session" ? Response.json({ status: "UNAUTHORIZED" }, { status: 401 })
            : url.endsWith("/login") ? Response.json(sessionData()) : new Promise(resolve => { revoke = resolve; }));
    await page.settle();
    page.node('[data-action="logout"]').listeners.click();
    assert.equal(page.node("#trigger-admin").hidden, false);
    assert.equal(runButton(page).disabled, true);
    revoke(Response.json({ status: "SIGNED_OUT" }));
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.equal(page.node("[data-readiness]").children.length, 0);
    assert.equal(page.node("[data-config-items]").children.length, 0);
    assert.equal(page.node("[data-config-diagnostic]").textContent, "");
});

test("repeated logout clicks create only one revocation request", async () => {
    let revoke;
    const page = bootstrap(true, async () => Response.json({ status: "OK", targets: [] }), false, "",
        async url => url === "/api/admin/session" ? Response.json({ status: "UNAUTHORIZED" }, { status: 401 })
            : url.endsWith("/login") ? Response.json(sessionData()) : new Promise(resolve => { revoke = resolve; }));
    await page.settle();
    page.node('[data-action="logout"]').listeners.click();
    page.node('[data-action="logout"]').listeners.click();
    assert.equal(page.calls.filter(call => call.url.endsWith("/logout")).length, 1);
    revoke(Response.json({ status: "SIGNED_OUT" }));
    await page.settle();
});

test("health transport failures remove stale configuration rows and report unknown readiness", async () => {
    let fail = false;
    const page = bootstrap(true, async url => {
        if (url === "/health") { if (fail) throw Error("private_failure_marker"); return Response.json(visualHealth()); }
        return Response.json({ status: "OK", targets: [] });
    }, true);
    await page.settle();
    fail = true;
    page.node('[data-action="refresh"]').listeners.click();
    await page.settle();
    assert.ok(!textTree(page.node("[data-config-items]")).includes("fixture/team"));
    assert.match(textTree(page.node("[data-config-items]")), /读取失败|无法确认/);
    assert.equal(page.node("[data-config-diagnostic]").textContent, "");
});

test("session capacity rejection is actionable without displaying backend detail", async () => {
    const page = bootstrap(true, () => assert.fail("No private reads after rejected login"), false, "",
        async url => Response.json({ status: url.endsWith("/login") ? "SESSION_LIMIT" : "UNAUTHORIZED", detail: "private_capacity_marker" },
            { status: url.endsWith("/login") ? 429 : 401 }));
    await page.settle();
    assert.equal(page.node("#trigger-admin").hidden, true);
    assert.match(page.node("[data-access-feedback]").textContent, /会话.*满/);
    assert.ok(!page.node("[data-access-feedback]").textContent.includes("private_capacity_marker"));
});

test("partial and malformed health fields stay unknown instead of reporting concrete readiness", async (t) => {
    for (const [name, extra] of [["missing fields", {}], ["malformed fields", {
        github_tokens: { configured: "private_count_marker", missing: -1, invalid: 101 },
        storage_binding: { configured: "private_binding_marker" }, wecom: { state: "private_wecom_marker" },
    }], ["partial token counts", { github_tokens: { configured: 2, missing: 1 } }]]) {
        await t.test(name, async () => {
            const page = bootstrap(true, async url => Response.json(url === "/health"
                ? { config: { state: "valid" }, ...extra } : { status: "OK", targets: [] }), true);
            await page.settle();
            const panels = page.node("[data-readiness]").children;
            for (const index of [1, 2, 3]) assert.match(textTree(panels[index]), /待确认|无法确认/);
            const summary = page.node("[data-config-summary]").textContent;
            assert.ok(!/已填写 0|缺失 0|不合法 0|未绑定|未配置或不合法/.test(summary));
            assert.match(textTree(page.node("[data-config-items]")), /无法确认|待确认/);
            assert.ok(!textTree(page.node("[data-config-items]")).includes("暂无配置目标"));
            const diagnostic = page.node("[data-config-diagnostic]").textContent;
            assert.match(diagnostic, /github_tokens: unknown/);
            assert.match(diagnostic, /storage_binding: unknown/);
            assert.match(diagnostic, /wecom: unknown/);
            assert.ok(![summary, diagnostic].join(" ").includes("private_"));
        });
    }
});

test("explicit validated empty and missing health state remains concrete", async () => {
    const page = bootstrap(true, async url => Response.json(url === "/health" ? {
        config: { state: "valid", items: [] }, github_tokens: { configured: 0, missing: 0, invalid: 0 },
        storage_binding: { configured: false }, wecom: { state: "missing" },
    } : { status: "OK", targets: [] }), true);
    await page.settle();
    const panels = page.node("[data-readiness]").children;
    assert.match(textTree(panels[1]), /已填写 0.*缺失 0.*不合法 0/);
    assert.match(textTree(panels[2]), /缺失/);
    assert.match(textTree(panels[3]), /未配置/);
    assert.match(textTree(page.node("[data-config-items]")), /暂无配置目标/);
});

test("missing configuration state stays unknown and never permits target listing", async () => {
    const page = bootstrap(true, async url => {
        assert.equal(url, "/health");
        return Response.json({ config: {} });
    }, true);
    await page.settle();
    assert.match(textTree(page.node("[data-readiness]").children[0]), /待确认|无法确认/);
    assert.ok(!textTree(page.node("[data-readiness]").children[0]).includes("配置错误"));
    assert.match(page.node("[data-config-diagnostic]").textContent, /config.state: unknown/);
});

test("malformed inspection collection does not pretend there are zero configured targets", async (t) => {
    for (const items of [null, {}, Array(101).fill(inspectedItem)]) await t.test(typeof items, async () => {
        const page = bootstrap(true, async url => Response.json(url === "/health" ? visualHealth("valid", items)
            : { status: "OK", targets: [] }), true);
        await page.settle();
        assert.match(textTree(page.node("[data-config-items]")), /无法确认|待确认/);
        assert.ok(!textTree(page.node("[data-config-items]")).includes("暂无配置目标"));
    });
});

test("fixed list length failures get list advice rather than random count and window advice", async (t) => {
    for (const times of [[], Array(25).fill("08:30")]) await t.test("times length " + times.length, async () => {
        const error = { field: "targets[0].schedule.times", code: "SCHEDULE_COUNT" };
        const page = bootstrap(true, async () => Response.json(visualHealth("invalid", [{ ...inspectedItem,
            schedule: { mode: "fixed", times }, error }], error)), true);
        await page.settle();
        const advice = page.node("[data-config-advice]").textContent;
        assert.match(advice, /固定.*1.*24.*HH:mm/);
        assert.ok(!/整数|窗口/.test(advice));
    });
});
