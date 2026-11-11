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

function bootstrap(autoLogin, handler, customHealth = false, hash = "", sessionHandler, catalogHandler) {
    const nodes = new Map();
    const node = (selector) => {
        if (!nodes.has(selector)) nodes.set(selector, { hidden: selector === "#trigger-admin", textContent: "",
            children: [], listeners: {}, dataset: {}, attributes: {},
            addEventListener(name, fn) { this.listeners[name] = fn; },
            replaceChildren(...children) { this.children = children; },
            append(...children) { this.children.push(...children); },
            setAttribute(name, value) { this.attributes[name] = value; }, focus() {}, close() { this.open = false; }, showModal() { this.open = true; }, querySelector: node, querySelectorAll() { return []; } });
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
        document: { querySelector: node, getElementById: id => {
            const visit = item => item.id === id ? item : item.children?.map(visit).find(Boolean);
            return [...nodes.values()].map(visit).find(Boolean);
        }, createElement: (tag) => ({ ...node("element-" + tag + "-" + nodes.size), tagName: tag.toUpperCase() }) },
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
            if (url === "/api/admin/catalog") {
                calls.push({ url, options });
                return catalogHandler ? catalogHandler(url, options) : Response.json({ status: "OK", version: 1, revision: 0, items: [], credentials: [] });
            }
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
            assert.equal(runButton(page).textContent, "运行");
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
    assert.equal(runButton(page).textContent, "运行");
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

test("navigation sections separate operations diagnostics and repository-grouped history", async () => {
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

test("usage navigation is local, exclusive and leaves editor drafts unchanged", async () => {
    const page = bootstrap(true, async () => targetReply(editableTarget));
    await page.settle();
    editField(page, "count", "3");
    const calls = page.calls.length;
    assert.equal(typeof page.node('[data-view="usage"]').listeners.click, "function");
    page.node('[data-view="usage"]').listeners.click();
    for (const view of ["repositories", "config", "logs", "usage"])
        assert.equal(page.node(`[data-section="${view}"]`).hidden, view !== "usage");
    assert.equal(page.node('[data-view="usage"]').attributes["aria-pressed"], "true");
    assert.equal(page.node("[data-page-title]").textContent, "使用说明");
    page.node('[data-view="repositories"]').listeners.click();
    assert.equal(page.node('[data-section="usage"]').hidden, true);
    assert.equal(field(page, "count").value, "3");
    assert.equal(page.calls.length, calls, "Reading instructions must not fetch or save settings");
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
    assert.match(text, /当前执行计划.*08:30.*GitHub 已受理.*13:00.*结果未知.*20:30.*已跳过/);
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

const editableTarget = { ...uiTarget, schedule: { mode: "random", count: 2, window: { start: "09:00", end: "22:00" }, min_interval_minutes: 60 },
    schedule_source: "database", schedule_revision: 4,
    target_binding: '["primary","[\\"fixture/team\\",\\"Checkin.yml\\",\\"main\\"]"]',
    automatic_state: "known", automatic_last_at: "2026-11-10T01:00:00.000Z", automatic_next_allowed_at: "2026-11-10T02:00:00.000Z" };
function findEditor(page, key, value) {
    const visit = item => item.dataset?.[key] === value ? item : item.children?.map(visit).find(Boolean);
    const listResult = page.node("[data-targets]").children.map(visit).find(Boolean);
    if (listResult) return listResult;
    const dialog = page.node("[data-target-editor]");
    if (!dialog.open) {
        const settings = page.node("[data-targets]").children.map(item => findNode(item, "action", "settings")).find(Boolean);
        settings?.listeners.click();
    }
    return visit(dialog);
}
const field = (page, name) => findEditor(page, "scheduleField", name);
const editorAction = (page, name) => findEditor(page, "action", "schedule-" + name);
function editField(page, name, value) {
    const input = field(page, name);
    assert.ok(input, "Labeled editor field must exist: " + name);
    input.value = value;
    input.listeners[name === "mode" ? "change" : "input"]();
}
function submitSchedule(page) {
    const form = findEditor(page, "scheduleForm", "primary");
    assert.ok(form, "Schedule form must exist");
    form.listeners.submit({ preventDefault() {} });
}
const targetReply = target => Response.json({ status: "OK", targets: [target] });

test("effective schedules expose labeled mode-specific controls and independent interval checkpoints", async () => {
    const page = bootstrap(true, async () => targetReply(editableTarget));
    await page.settle();
    for (const name of ["mode", "count", "start", "end", "interval"]) assert.ok(field(page, name), name);
    assert.equal(field(page, "start").type, "time");
    assert.equal(field(page, "interval").min, "1");
    assert.equal(field(page, "interval").max, "525600");
    assert.equal(field(page, "time"), undefined);
    const text = textTree(page.node("[data-targets]"));
    assert.match(text, /自动最小间隔 1 小时/);
    assert.match(text, /来源：数据库设置.*上次自动尝试/);
    assert.ok(editorAction(page, "reset"));
    editField(page, "mode", "fixed");
    assert.equal(field(page, "count"), undefined);
    assert.ok(field(page, "time"));
    assert.equal(field(page, "start"), undefined);
});

test("fixed add and delete derive daily count without submitting unrelated mode fields", async () => {
    const target = { ...editableTarget, schedule: { mode: "fixed", times: ["20:30"], min_interval_minutes: 60 } };
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(target)
        : Response.json({ status: "SCHEDULE_INVALID", error: { field: "schedule.times", code: "SCHEDULE_TIME" } }, { status: 400 }));
    await page.settle();
    editorAction(page, "add").listeners.click();
    assert.match(textTree(page.node("[data-target-editor]")), /2 次\/天/);
    editorAction(page, "remove").listeners.click();
    assert.match(textTree(page.node("[data-target-editor]")), /1 次\/天/);
    editField(page, "time", "08:30");
    submitSchedule(page);
    await page.settle();
    const call = page.calls.find(call => call.url.endsWith("/schedule"));
    assert.deepEqual(JSON.parse(call.options.body), { binding: target.target_binding, revision: 4,
        schedule: { mode: "fixed", times: ["08:30"], min_interval_minutes: 60 } });
});

test("save sends a revision-bound canonical payload with Cookie and CSRF and replaces effective state", async () => {
    const saved = { ...editableTarget, schedule_revision: 5,
        schedule: { mode: "random", count: 3, window: { start: "08:00", end: "21:00" } } };
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
        : Response.json({ status: "SCHEDULE_UPDATED", target: saved }));
    await page.settle();
    editField(page, "count", "3"); editField(page, "start", "08:00"); editField(page, "end", "21:00"); editField(page, "interval", "1");
    submitSchedule(page);
    await page.settle();
    const call = page.calls.find(call => call.url.endsWith("/schedule"));
    assert.equal(call.options.credentials, "same-origin");
    assert.equal(call.options.headers["X-CSRF-Token"], sessionData().csrf_token);
    assert.equal(call.options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(call.options.body), { binding: editableTarget.target_binding, revision: 4, schedule: saved.schedule });
    assert.equal(field(page, "count").value, "3");
    assert.match(page.node("[data-feedback]").textContent, /已保存.*未触发运行/);
});

test("ordinary refresh preserves edit-start revision and conflict requires explicit saved-value loading", async () => {
    let server = editableTarget;
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(server)
        : Response.json({ status: "SCHEDULE_CONFLICT" }, { status: 409 }));
    await page.settle();
    editField(page, "count", "3");
    page.node('[data-action="refresh"]').listeners.click(); await page.settle();
    assert.equal(field(page, "count").value, "3");
    submitSchedule(page); await page.settle();
    assert.equal(JSON.parse(page.calls.find(call => call.url.endsWith("/schedule")).options.body).revision, 4);
    assert.equal(field(page, "count").value, "3");
    assert.equal(editorAction(page, "save").disabled, true);
    server = { ...editableTarget, schedule_revision: 5, schedule: { ...editableTarget.schedule, count: 4 } };
    page.node('[data-action="refresh"]').listeners.click(); await page.settle();
    assert.equal(field(page, "count").value, "3");
    assert.equal(editorAction(page, "save").disabled, true);
    editorAction(page, "load").listeners.click();
    await page.settle();
    assert.equal(field(page, "count").value, "4");
    assert.equal(editorAction(page, "save").disabled, false);
});

test("revision advances discovered by refresh cannot silently rebase a dirty draft", async () => {
    let server = editableTarget;
    const page = bootstrap(true, async () => targetReply(server));
    await page.settle(); editField(page, "interval", "120");
    server = { ...editableTarget, schedule_revision: 5 };
    page.node('[data-action="refresh"]').listeners.click(); await page.settle();
    assert.equal(field(page, "interval").value, "120");
    assert.equal(editorAction(page, "save").disabled, true);
    submitSchedule(page); await page.settle();
    assert.ok(!page.calls.some(call => call.url.endsWith("/schedule")));
});

test("target identity refresh discards a draft instead of moving it to another repository", async () => {
    let server = editableTarget;
    const page = bootstrap(true, async () => targetReply(server));
    await page.settle(); editField(page, "count", "3");
    server = { ...editableTarget, repository: "fixture/new", schedule_source: "variable", schedule_revision: 0,
        target_binding: '["primary","[\\"fixture/new\\",\\"Checkin.yml\\",\\"main\\"]"]' };
    page.node('[data-action="refresh"]').listeners.click(); await page.settle();
    assert.equal(field(page, "count").value, "2");
});

test("restoring variables requires confirmation and posts only identity and revision", async () => {
    const restored = { ...editableTarget, schedule_source: "variable", schedule_revision: 5,
        schedule: { mode: "fixed", times: ["08:30"] } };
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
        : Response.json({ status: "SCHEDULE_RESET", target: restored }));
    await page.settle();
    editorAction(page, "reset").listeners.click();
    assert.ok(!page.calls.some(call => call.url.endsWith("/schedule/reset")));
    assert.match(page.node("[data-dialog-message]").textContent, /变量/);
    page.node("[data-cancel]").listeners.click();
    assert.ok(!page.calls.some(call => call.url.endsWith("/schedule/reset")));
    editorAction(page, "reset").listeners.click(); page.node("[data-confirm]").listeners.click(); await page.settle();
    assert.deepEqual(JSON.parse(page.calls.find(call => call.url.endsWith("/schedule/reset")).options.body),
        { binding: editableTarget.target_binding, revision: 4 });
    assert.equal(field(page, "time").value, "08:30");
});

test("double submits serialize saves while every target action is disabled", async () => {
    let finish;
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
        : new Promise(resolve => { finish = resolve; }));
    await page.settle();
    submitSchedule(page); submitSchedule(page);
    assert.equal(page.calls.filter(call => call.url.endsWith("/schedule")).length, 1);
    assert.equal(editorAction(page, "reset").disabled, true);
    assert.equal(runButton(page).disabled, true);
    finish(Response.json({ status: "SCHEDULE_UPDATED", target: { ...editableTarget, schedule_revision: 5 } })); await page.settle();
});

test("late save and late JSON decoding cannot restore state after logout or a new login", async () => {
    let finish;
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
        : new Promise(resolve => { finish = resolve; }));
    await page.settle(); editField(page, "count", "3"); submitSchedule(page);
    page.node('[data-action="logout"]').listeners.click(); await page.settle();
    page.login(); await page.settle();
    const messageBeforeLateReply = page.node("[data-feedback]").textContent;
    finish(Response.json({ status: "SCHEDULE_UPDATED", target: { ...editableTarget, schedule_revision: 5,
        schedule: { ...editableTarget.schedule, count: 3 } } })); await page.settle();
    assert.equal(field(page, "count").value, "2");
    assert.equal(page.node("[data-feedback]").textContent, messageBeforeLateReply);
});

test("ambiguous 503 reads actual settings once without resubmitting and keeps draft blocked", async () => {
    let server = editableTarget;
    const page = bootstrap(true, async (_url, options) => {
        if (options.method === "GET") return targetReply(server);
        server = { ...editableTarget, schedule_revision: 5, schedule: { ...editableTarget.schedule, count: 3 } };
        return Response.json({ status: "STORAGE_UNAVAILABLE", detail: "private_alarm_marker" }, { status: 503 });
    });
    await page.settle(); editField(page, "count", "3"); submitSchedule(page); await page.settle();
    assert.equal(page.calls.filter(call => call.url.endsWith("/schedule")).length, 1);
    assert.equal(page.calls.filter(call => call.url === "/api/admin/targets").length, 2);
    assert.equal(field(page, "count").value, "3");
    assert.equal(editorAction(page, "save").disabled, true);
    assert.match(page.node("[data-feedback]").textContent, /未确认|未知/);
    assert.match(page.node("[data-feedback]").textContent, /Alarm|自动.*状态/);
    assert.ok(!textTree(page.node("[data-targets]")).includes("private_alarm_marker"));
});

test("failed unknown readback retains draft for later read and does not claim unsaved failure", async () => {
    let reads = 0;
    const page = bootstrap(true, async (_url, options) => options.method === "GET"
        ? ++reads === 1 ? targetReply(editableTarget) : Promise.reject(Error("private_read_marker"))
        : Response.json({ status: "STORAGE_UNAVAILABLE" }, { status: 503 }));
    await page.settle(); editField(page, "count", "3"); submitSchedule(page); await page.settle();
    assert.match(page.node("[data-feedback]").textContent, /未知|未确认/);
    assert.ok(!/完全没保存|未保存成功/.test(page.node("[data-feedback]").textContent));
    assert.equal(field(page, "count").value, "3");
    assert.equal(editorAction(page, "save").disabled, true);
});

test("safe server validation is inline and preserves input without printing raw diagnostics", async (t) => {
    for (const [error, expected] of [[{ field: "schedule.min_interval_minutes", code: "SCHEDULE_INTERVAL" }, /1.*525600/],
        [{ field: "schedule.times", code: "SCHEDULE_SPACING" }, /次日|循环/],
        [{ field: "private_field_marker", code: "private_code_marker" }, /排期|不可识别/]]) {
        await t.test(error.code, async () => {
            const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
                : Response.json({ status: "SCHEDULE_INVALID", error }, { status: 400 }));
            await page.settle(); editField(page, "count", "3"); submitSchedule(page); await page.settle();
            assert.equal(field(page, "count").value, "3");
            assert.match(textTree(page.node("[data-targets]")), expected);
            assert.ok(!textTree(page.node("[data-targets]")).includes("private_"));
            assert.equal(editorAction(page, "save").disabled, false);
        });
    }
});

test("stale identity and exhausted revisions block retries without an automatic overwrite", async (t) => {
    for (const status of ["TARGET_CHANGED", "SCHEDULE_REVISION_LIMIT"]) await t.test(status, async () => {
        const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
            : Response.json({ status }, { status: status === "TARGET_CHANGED" ? 409 : 429 }));
        await page.settle(); editField(page, "count", "3"); submitSchedule(page); await page.settle();
        assert.equal(field(page, "count").value, "3");
        assert.equal(editorAction(page, "save").disabled, true);
        assert.equal(page.calls.filter(call => call.url.endsWith("/schedule")).length, 1);
    });
});

test("interval skips display the cause and never become success or GitHub rejection", async () => {
    const target = { ...editableTarget, slots: [{ at: "2026-11-10T01:30:00.000Z", attempted: true, result: "INTERVAL_SKIPPED" }] };
    const page = bootstrap(true, async () => targetReply(target)); await page.settle();
    assert.match(textTree(page.node("[data-targets]")), /最小间隔未到.*不补发/);
    assert.ok(!/GitHub 拒绝|成功触发/.test(textTree(page.node("[data-targets]"))));
});

test("rolled interval skip displays its prior date and cause alongside tomorrow slots without history", async () => {
    const target = { ...editableTarget, schedule_date: "2026-11-10",
        slots: [{ at: "2026-11-10T01:00:00.000Z", attempted: false, result: "PLANNED" }], history: [],
        schedule_last: { date: "2026-11-09", at: "2026-11-09T01:00:00.000Z", result: "INTERVAL_SKIPPED" } };
    const page = bootstrap(true, async () => targetReply(target)); await page.settle();
    const text = textTree(page.node("[data-targets]"));
    assert.match(text, /上一计划结果.*2026-11-09.*09:00.*最小间隔未到.*不补发/);
    assert.match(text, /当前执行计划.*2026-11-10.*待执行/);
    assert.ok(!/GitHub 拒绝|成功触发/.test(text));
    assert.ok(editorAction(page, "save"));
});

test("replaced pending plan is hidden while current plan has separate date time and status columns", async () => {
    const target = { ...editableTarget, schedule_date: "2026-11-11",
        slots: [{ at: "2026-11-11T02:17:00.000Z", attempted: false, result: "PLANNED" }],
        schedule_last: { date: "2026-11-11", at: "2026-11-11T05:35:00.000Z", result: "PLANNED" } };
    const page = bootstrap(true, async () => targetReply(target)); await page.settle();
    const text = textTree(page.node("[data-targets]"));
    assert.ok(!text.includes("13:35"), "A superseded pending slot is not another upcoming trigger");
    const tables = [];
    const visit = item => {
        if (item.className === "ar-plan-table") tables.push(item);
        item.children?.forEach(visit);
    };
    visit(page.node("[data-targets]"));
    assert.equal(tables.length, 1);
    const caption = tables[0].children.find(item => item.tagName === "CAPTION");
    assert.match(textTree(caption), /当前执行计划.*2026-11-11/);
    assert.match(textTree(tables[0]), /时间.*状态.*10:17.*待执行/);
    assert.ok(editorAction(page, "save"), "Valid legacy prior summary must not block editing");
});

test("prior plan summary accepts safe results without reclassifying unknown or missed attempts", async t => {
    for (const [result, status] of [["DISPATCH_ACCEPTED", /GitHub 已受理/], ["DISPATCH_UNKNOWN", /结果未知/],
        ["DISPATCH_HTTP_500", /GitHub 拒绝/], ["MISSED_DATE", /已跳过.*不补发/],
        ["TARGET_CHANGED", /已跳过.*不补发/]]) await t.test(result, async () => {
        const page = bootstrap(true, async () => targetReply({ ...editableTarget,
            schedule_last: { date: "2026-11-09", at: "2026-11-09T01:00:00.000Z", result } }));
        await page.settle();
        assert.match(textTree(page.node("[data-targets]")), status);
        assert.ok(editorAction(page, "save"));
    });
});

test("malformed prior plan summaries fail closed without rendering raw fields or enabling edits", async t => {
    const last = { date: "2026-11-09", at: "2026-11-09T01:00:00.000Z", result: "INTERVAL_SKIPPED" };
    for (const [name, schedule_last] of [["null", null], ["array", []],
        ["missing date", { at: last.at, result: last.result }], ["invalid date", { ...last, date: "2026-02-30" }],
        ["wrong local date", { ...last, at: "2026-11-09T17:00:00.000Z" }],
        ["invalid timestamp", { ...last, at: "private_timestamp_marker" }],
        ["noncanonical timestamp", { ...last, at: "2026-11-09T09:00:00+08:00" }],
        ["unknown result", { ...last, result: "private_result_marker" }],
        ["raw extra field", { ...last, secret: "private_record_marker" }]]) await t.test(name, async () => {
        const page = bootstrap(true, async () => targetReply({ ...editableTarget, schedule_last })); await page.settle();
        const text = textTree(page.node("[data-targets]"));
        assert.match(text, /不可识别|读取失败/);
        assert.ok(!text.includes("private_"));
        assert.equal(editorAction(page, "save"), undefined);
    });
});

test("malformed schedule metadata and interval fields fail closed rather than authorizing edits", async (t) => {
    for (const extra of [{ schedule_revision: 1.5 }, { target_binding: "private_binding_marker" },
        { schedule_source: "private_source_marker" }, { automatic_state: "known", automatic_last_at: "bad" },
        { schedule: { ...editableTarget.schedule, min_interval_minutes: "60" } },
        { schedule: { ...editableTarget.schedule, unexpected: "private_schedule_marker" } }]) await t.test(JSON.stringify(extra), async () => {
        const page = bootstrap(true, async () => targetReply({ ...editableTarget, ...extra })); await page.settle();
        assert.equal(editorAction(page, "save"), undefined);
        assert.ok(!textTree(page.node("[data-targets]")).includes("private_"));
        assert.match(textTree(page.node("[data-targets]")), /不可识别|读取失败/);
    });
});

test("reload restores saved effective schedule and logout clears unsaved memory drafts", async () => {
    const page = bootstrap(true, async () => targetReply(editableTarget)); await page.settle();
    editField(page, "count", "3");
    page.node('[data-action="logout"]').listeners.click(); await page.settle(); page.login(); await page.settle();
    assert.equal(field(page, "count").value, "2");
    const reload = bootstrap(false, async () => targetReply(editableTarget), false, "", async () => Response.json(sessionData()));
    await reload.settle(); assert.equal(field(reload, "count").value, "2");
});

test("a session ending during save JSON decoding cannot replace the newer authenticated state", async () => {
    let finishJSON;
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
        : { status: 200, ok: true, json: () => new Promise(resolve => { finishJSON = resolve; }) });
    await page.settle(); submitSchedule(page); await page.settle();
    page.node('[data-action="logout"]').listeners.click(); await page.settle(); page.login(); await page.settle();
    const feedback = page.node("[data-feedback]").textContent;
    finishJSON({ status: "SCHEDULE_UPDATED", target: { ...editableTarget, schedule_revision: 5,
        schedule: { ...editableTarget.schedule, count: 4 } } }); await page.settle();
    assert.equal(field(page, "count").value, "2");
    assert.equal(page.node("[data-feedback]").textContent, feedback);
});

test("unknown readback ending after logout cannot apply the late target state", async () => {
    let reads = 0, finish;
    const page = bootstrap(true, async (_url, options) => options.method === "GET"
        ? ++reads === 2 ? new Promise(resolve => { finish = resolve; }) : targetReply(editableTarget)
        : Response.json({ status: "STORAGE_UNAVAILABLE" }, { status: 503 }));
    await page.settle(); submitSchedule(page); await page.settle();
    page.node('[data-action="logout"]').listeners.click(); await page.settle(); page.login(); await page.settle();
    const feedback = page.node("[data-feedback]").textContent;
    finish(targetReply({ ...editableTarget, schedule_revision: 5 })); await page.settle();
    assert.equal(field(page, "count").value, "2");
    assert.equal(page.node("[data-feedback]").textContent, feedback);
});

test("discard action cannot discard a draft when effective saved state could not be read", async () => {
    let server = editableTarget;
    const page = bootstrap(true, async () => targetReply(server)); await page.settle();
    editField(page, "count", "3");
    server = { ...editableTarget, error: "STORAGE_UNAVAILABLE", schedule_source: null, schedule_revision: null,
        target_binding: null, automatic_state: "unknown", automatic_last_at: null, automatic_next_allowed_at: null };
    editorAction(page, "load").listeners.click(); await page.settle();
    assert.match(page.node("[data-feedback]").textContent, /未确认|不可用/);
    server = editableTarget;
    page.node('[data-action="refresh"]').listeners.click(); await page.settle();
    assert.equal(field(page, "count").value, "3");
});

test("late toggle events from an old editor cannot repopulate cleared logout drafts", async () => {
    const page = bootstrap(true, async () => targetReply(editableTarget)); await page.settle();
    editField(page, "count", "3");
    const oldDetails = findEditor(page, "scheduleTargetId", "primary");
    page.node('[data-action="logout"]').listeners.click(); await page.settle();
    page.login(); await page.settle();
    oldDetails.open = true;
    oldDetails.listeners.toggle();
    page.node('[data-action="refresh"]').listeners.click(); await page.settle();
    assert.equal(field(page, "count").value, "2");
});

test("disconnected editor toggles cannot resurrect a draft cleared by a successful save", async () => {
    const saved = { ...editableTarget, schedule_revision: 5, schedule: { ...editableTarget.schedule, count: 4 } };
    const page = bootstrap(true, async (url, options) => options.method === "GET" ? targetReply(editableTarget)
        : Response.json({ status: url.endsWith("/enabled") ? "ENABLED_UPDATED" : "SCHEDULE_UPDATED", target: saved })); await page.settle();
    editField(page, "count", "3");
    const oldDetails = findEditor(page, "scheduleTargetId", "primary");
    submitSchedule(page); await page.settle();
    oldDetails.isConnected = false; oldDetails.open = true; oldDetails.listeners.toggle();
    // A regular operation redraws the cards without changing their saved settings.
    findEditor(page, "action", "toggle").listeners.change(); await page.settle();
    assert.equal(field(page, "count").value, "4");
});

test("unknown save readback with unavailable target metadata cannot claim effective settings were read", async () => {
    let reads = 0;
    const unavailable = { ...editableTarget, error: "STORAGE_UNAVAILABLE", schedule_source: null, schedule_revision: null,
        target_binding: null, automatic_state: "unknown", automatic_last_at: null, automatic_next_allowed_at: null };
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(++reads === 1 ? editableTarget : unavailable)
        : Response.json({ status: "STORAGE_UNAVAILABLE" }, { status: 503 }));
    await page.settle(); editField(page, "count", "3"); submitSchedule(page); await page.settle();
    assert.match(page.node("[data-feedback]").textContent, /读取也未确认/);
    assert.ok(!/已读取实际设置/.test(page.node("[data-feedback]").textContent));
});

test("closed or missing-token targets may edit schedules without enabling or running them", async (t) => {
    for (const extra of [{ enabled: false }, { token_state: "missing" }]) await t.test(JSON.stringify(extra), async () => {
        const page = bootstrap(true, async () => targetReply({ ...editableTarget, ...extra })); await page.settle();
        assert.equal(editorAction(page, "save").disabled, false);
        assert.equal(editorAction(page, "reset").disabled, false);
        assert.equal(runButton(page).disabled, true);
    });
});

test("error fallback metadata leaves management blocked without claiming a variable source", async () => {
    const target = { ...editableTarget, error: "STATE_INVALID", schedule_source: null, schedule_revision: null,
        target_binding: null, automatic_state: "unknown", automatic_last_at: null, automatic_next_allowed_at: null };
    const page = bootstrap(true, async () => targetReply(target)); await page.settle();
    assert.equal(editorAction(page, "save"), undefined);
    assert.equal(runButton(page).disabled, true);
    assert.match(textTree(page.node("[data-targets]")), /状态不可用/);
    assert.ok(!/生效排期.*变量配置/.test(textTree(page.node("[data-targets]"))));
});

test("toggle response with a newer schedule revision marks existing draft conflicted instead of leaving a silent save", async () => {
    const newer = { ...editableTarget, enabled: false, schedule_revision: 5, schedule: { ...editableTarget.schedule, count: 4 } };
    const page = bootstrap(true, async (_url, options) => options.method === "GET" ? targetReply(editableTarget)
        : Response.json({ status: "ENABLED_UPDATED", target: newer })); await page.settle();
    editField(page, "count", "3");
    const toggle = findEditor(page, "action", "toggle"); toggle.checked = false; toggle.listeners.change(); await page.settle();
    assert.equal(field(page, "count").value, "3");
    assert.equal(editorAction(page, "save").disabled, true);
    assert.match(textTree(page.node("[data-targets]")), /其他页面/);
});

const catalogItem = { id: "primary", name: "daily-checkin", repository: "fixture/team", workflow: "Checkin.yml", ref: "main",
    token_secret: "GITHUB_TOKEN_A", enabled: true, schedule: { mode: "fixed", times: ["08:30"] } };
const catalogTarget = { ...editableTarget, name: catalogItem.name, token_secret: catalogItem.token_secret, catalog_revision: 1 };
const runtimeBinding = target => JSON.stringify([target.id, JSON.stringify([target.repository.toLowerCase(), target.workflow, target.ref])]);
const catalogReply = (items = [catalogItem], revision = 7, credentials = ["GITHUB_TOKEN_A", "GITHUB_TOKEN_B"]) =>
    Response.json({ status: "OK", version: 1, revision, items, credentials });
function findNode(tree, key, value) {
    const visit = item => item.dataset?.[key] === value ? item : item.children?.map(visit).find(Boolean);
    return visit(tree);
}
const popupField = (page, name) => findNode(page.node("[data-target-editor]"), "scheduleField", name);
const popupAction = (page, name) => findNode(page.node("[data-target-editor]"), "action", name);
function popupEdit(page, name, value) {
    const input = popupField(page, name); assert.ok(input, name); input.value = value;
    input.listeners[input.tagName === "SELECT" ? "change" : "input"]();
}
function openTarget(page, id = "primary") {
    const article = findNode(page.node("[data-targets]"), "targetId", id);
    const settings = findNode(article, "action", "settings"); assert.ok(settings, "Target settings action exists");
    settings.listeners.click();
}
function popupSubmit(page) {
    const form = findNode(page.node("[data-target-editor]"), "scheduleForm", "primary")
        ?? findNode(page.node("[data-target-editor]"), "scheduleForm", "__new");
    assert.ok(form); form.listeners.submit({ preventDefault() {} });
}
function managedPage(targetsHandler = async () => targetReply(catalogTarget), handler = async () => catalogReply()) {
    return bootstrap(true, targetsHandler, false, "", undefined, handler);
}

test("compact target settings open only the clicked native popup with effective schedule and visible identity", async () => {
    const second = { ...catalogTarget, id: "secondary", name: "backup", repository: "fixture/backup", catalog_revision: 2,
        target_binding: '["secondary","[\\"fixture/backup\\",\\"Checkin.yml\\",\\"main\\"]"]' };
    const page = managedPage(async () => Response.json({ status: "OK", targets: [catalogTarget, second] }),
        async () => catalogReply([catalogItem, { ...catalogItem, id: "secondary", name: "backup", repository: "fixture/backup" }]));
    await page.settle();
    assert.equal(page.calls.filter(call => call.url === "/api/admin/catalog").length, 1);
    assert.ok(!findNode(page.node("[data-targets]"), "scheduleForm", "primary"), "List has no in-card editor");
    assert.match(textTree(page.node("[data-targets]")), /daily-checkin.*fixture\/team.*Checkin.yml.*main/);
    openTarget(page, "secondary");
    assert.equal(page.node("[data-target-editor]").open, true);
    assert.match(textTree(page.node("[data-target-editor]")), /backup.*fixture\/backup/);
    assert.equal(popupField(page, "repository").value, "fixture/backup");
    assert.equal(popupField(page, "count").value, "2", "Effective runtime schedule overrides catalog import default");
    assert.ok(popupAction(page, "tab-basic")); assert.ok(popupAction(page, "tab-schedule"));
    popupEdit(page, "name", "not-saved"); popupAction(page, "editor-close").listeners.click();
    assert.equal(page.node("[data-target-editor]").open, false);
    assert.ok(!page.calls.some(call => call.url === "/api/admin/catalog" && call.options.method === "POST"));
});

test("catalog popup saves all fields once with global revision Cookie CSRF and canonical day minutes", async () => {
    let items = [catalogItem], revision = 7, runtime = catalogTarget;
    const page = managedPage(async () => targetReply(runtime), async (_url, options) => {
        if (options.method === "GET") return catalogReply(items, revision);
        const body = JSON.parse(options.body); items = [body.target]; revision = 8;
        runtime = { ...catalogTarget, ...body.target, catalog_revision: 2, schedule_revision: 5 };
        runtime.target_binding = runtimeBinding(runtime);
        return Response.json({ status: "CATALOG_UPDATED", revision, target: body.target });
    });
    await page.settle(); openTarget(page);
    popupEdit(page, "name", "daily-edited"); popupEdit(page, "repository", "fixture/new"); popupEdit(page, "ref", "dev");
    popupEdit(page, "workflow", "daily.yaml"); popupEdit(page, "token_secret", "GITHUB_TOKEN_B");
    popupEdit(page, "count", "1"); popupEdit(page, "interval", "2"); popupEdit(page, "interval-unit", "day");
    popupSubmit(page); popupSubmit(page); await page.settle();
    const posts = page.calls.filter(call => call.url === "/api/admin/catalog" && call.options.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].options.headers["X-CSRF-Token"], sessionData().csrf_token);
    assert.equal(posts[0].options.credentials, "same-origin");
    assert.deepEqual(JSON.parse(posts[0].options.body), { revision: 7, target: { id: "primary", name: "daily-edited",
        repository: "fixture/new", ref: "dev", workflow: "daily.yaml", token_secret: "GITHUB_TOKEN_B", enabled: true,
        schedule: { mode: "random", count: 1, window: { start: "09:00", end: "22:00" }, min_interval_minutes: 2880 } } });
    assert.match(page.node("[data-feedback]").textContent, /已保存.*未触发运行/);
    assert.equal(page.node("[data-target-editor]").open, false);
    assert.equal(page.node("[data-target-editor]").children.length, 0);
    openTarget(page);
    assert.equal(popupField(page, "name").value, "daily-edited");
    assert.equal(popupField(page, "repository").value, "fixture/new");
    assert.equal(popupField(page, "ref").value, "dev");
    assert.equal(popupField(page, "workflow").value, "daily.yaml");
    assert.equal(popupField(page, "token_secret").value, "GITHUB_TOKEN_B");
    assert.equal(popupField(page, "interval").value, "2");
    assert.equal(popupField(page, "interval-unit").value, "day");
    assert.equal(popupAction(page, "schedule-save").disabled, false);
});

test("add target omits its ID and persists metadata from a new popup", async () => {
    const page = managedPage(async () => Response.json({ status: "OK", targets: [] }), async (_url, options) =>
        options.method === "GET" ? catalogReply([], 3) : Response.json({ status: "TARGET_INVALID", error: { field: "target.name", code: "TARGET_FIELD" } }, { status: 400 }));
    await page.settle(); page.node('[data-action="add-target"]').listeners.click();
    popupEdit(page, "name", "new target"); popupEdit(page, "repository", "fixture/new");
    popupSubmit(page); await page.settle();
    const body = JSON.parse(page.calls.find(call => call.options.method === "POST" && call.url === "/api/admin/catalog").options.body);
    assert.equal(body.revision, 3); assert.equal(body.target.name, "new target"); assert.equal(body.target.ref, "main");
    assert.equal(body.target.workflow, "Checkin.yml"); assert.equal(body.target.enabled, true);
    assert.ok(!Object.hasOwn(body.target, "id")); assert.ok(!Object.hasOwn(body.target, "binding"));
});

test("catalog conflict and unknown delivery retain blocked draft and never repeat POST", async t => {
    for (const status of [409, 503]) await t.test(String(status), async () => {
        const page = managedPage(async () => targetReply(catalogTarget), async (_url, options) => options.method === "GET" ? catalogReply()
            : Response.json({ status: status === 409 ? "CATALOG_CONFLICT" : "STORAGE_UNAVAILABLE", private: "private_marker" }, { status }));
        await page.settle(); openTarget(page); popupEdit(page, "name", "my draft"); popupSubmit(page); await page.settle();
        assert.equal(popupField(page, "name").value, "my draft");
        assert.equal(popupAction(page, "schedule-save").disabled, true);
        popupSubmit(page); await page.settle();
        assert.equal(page.calls.filter(call => call.url === "/api/admin/catalog" && call.options.method === "POST").length, 1);
        assert.match(page.node("[data-feedback]").textContent, status === 409 ? /其他页面|冲突/ : /未知|未确认/);
        assert.ok(!textTree(page.node("[data-target-editor]")).includes("private_marker"));
        if (status === 503) assert.equal(page.calls.filter(call => call.url === "/api/admin/catalog").length, 3);
    });
});

test("minute hour day controls reject fractional and greater-than-year intervals before POST", async t => {
    for (const [amount, unit] of [["1.5", "hour"], ["366", "day"], ["0", "minute"]]) await t.test(amount + unit, async () => {
        const page = managedPage(); await page.settle(); openTarget(page);
        popupEdit(page, "interval", amount); popupEdit(page, "interval-unit", unit); popupSubmit(page); await page.settle();
        assert.ok(!page.calls.some(call => call.url === "/api/admin/catalog" && call.options.method === "POST"));
        assert.match(textTree(page.node("[data-target-editor]")), /整数|365|间隔/);
    });
});

test("unsafe credential catalog and malformed catalog response fail closed without rendering raw secrets", async t => {
    for (const credentials of [["ADMIN_PASSWORD"], ["private_token_marker"], ["GITHUB_TOKEN_A", "GITHUB_TOKEN_A"]]) await t.test(credentials.join(), async () => {
        const page = managedPage(undefined, async () => catalogReply([catalogItem], 7, credentials)); await page.settle();
        assert.equal(page.node("[data-targets]").children.length, 1);
        assert.ok(!textTree(page.node("[data-targets]")).includes("fixture/team"));
        assert.equal(page.node('[data-action="add-target"]').disabled, true);
    });
});

test("late catalog save after dialog cancellation cannot reattach the closed popup", async () => {
    let finish, revision = 7;
    const page = managedPage(async () => targetReply(catalogTarget), async (_url, options) => options.method === "GET" ? catalogReply(undefined, revision)
        : new Promise(resolve => { finish = resolve; }));
    await page.settle(); openTarget(page); popupSubmit(page); await page.settle();
    popupAction(page, "editor-close").listeners.click();
    revision = 8;
    finish(Response.json({ status: "CATALOG_UPDATED", revision, target: { ...catalogItem, schedule: catalogTarget.schedule } })); await page.settle();
    assert.equal(page.node("[data-target-editor]").open, false);
    assert.equal(page.node("[data-target-editor]").children.length, 0);
});

test("catalog JSON finishing after logout cannot restore metadata credentials or drafts", async () => {
    let finish;
    const page = managedPage(async () => targetReply(catalogTarget), async (_url, options) => options.method === "GET" ? catalogReply()
        : { ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) });
    await page.settle(); openTarget(page); popupEdit(page, "name", "discard me"); popupSubmit(page); await page.settle();
    page.node('[data-action="logout"]').listeners.click(); await page.settle();
    page.login(); await page.settle();
    const message = page.node("[data-feedback]").textContent;
    finish({ status: "CATALOG_UPDATED", revision: 8, target: { ...catalogItem, schedule: catalogTarget.schedule, name: "discard me" } }); await page.settle();
    assert.equal(page.node("[data-target-editor]").children.length, 0);
    assert.equal(page.node("[data-feedback]").textContent, message);
    openTarget(page); assert.equal(popupField(page, "name").value, "daily-checkin");
});

test("unsafe runtime catalog metadata does not authorize or render target popup edits", async t => {
    for (const data of [{ name: "private_marker".repeat(100) }, { token_secret: "ADMIN_PASSWORD" }, { catalog_revision: 1.5 }]) await t.test(Object.keys(data)[0], async () => {
        const page = managedPage(async () => targetReply({ ...catalogTarget, ...data })); await page.settle();
        assert.ok(!findNode(page.node("[data-targets]"), "action", "settings"));
        assert.ok(!textTree(page.node("[data-targets]")).includes("private_marker"));
    });
});

test("hour input saves canonical minutes while rejecting two slots above one day", async () => {
    const page = managedPage(undefined, async (_url, options) => options.method === "GET" ? catalogReply()
        : Response.json({ status: "TARGET_INVALID", error: { field: "target.schedule.count", code: "SCHEDULE_CAPACITY" } }, { status: 400 }));
    await page.settle(); openTarget(page);
    popupEdit(page, "interval", "2"); popupEdit(page, "interval-unit", "hour"); popupSubmit(page); await page.settle();
    assert.equal(JSON.parse(page.calls.find(call => call.url === "/api/admin/catalog" && call.options.method === "POST").options.body).target.schedule.min_interval_minutes, 120);
    popupEdit(page, "interval", "2"); popupEdit(page, "interval-unit", "day"); popupSubmit(page); await page.settle();
    assert.equal(page.calls.filter(call => call.url === "/api/admin/catalog" && call.options.method === "POST").length, 1);
});

test("new targets default enabled and saved day intervals read back in days", async () => {
    const target = { ...catalogTarget, schedule: { mode: "fixed", times: ["08:30"], min_interval_minutes: 2880 } };
    const page = managedPage(async () => targetReply(target)); await page.settle(); openTarget(page);
    assert.equal(popupField(page, "interval").value, "2");
    assert.equal(popupField(page, "interval-unit").value, "day");
    popupAction(page, "editor-close").listeners.click();
    page.node('[data-action="add-target"]').listeners.click();
    assert.equal(popupField(page, "enabled").checked, true);
});

test("safe catalog field diagnostics name the invalid field without displaying raw detail", async () => {
    const page = managedPage(undefined, async (_url, options) => options.method === "GET" ? catalogReply()
        : Response.json({ status: "TARGET_INVALID", error: { field: "target.ref", code: "TARGET_FIELD", detail: "private_marker" } }, { status: 400 }));
    await page.settle(); openTarget(page); popupSubmit(page); await page.settle();
    assert.match(textTree(page.node("[data-target-editor]")), /target\.ref/);
    assert.ok(!textTree(page.node("[data-target-editor]")).includes("private_marker"));
});

test("catalog bootstrap after missing variable refreshes configuration checks from the database", async () => {
    let imported = false;
    const page = bootstrap(true, async url => url === "/health" ? Response.json({ config: { state: imported ? "valid" : "missing", source: imported ? "database" : "variable", items: [] },
        github_tokens: { configured: 0, missing: 0, invalid: 0 }, wecom: { state: "missing" }, storage_binding: { configured: true } })
        : Response.json({ status: "OK", targets: [] }), true, "", undefined,
        async () => { imported = true; return catalogReply([], 1, []); });
    await page.settle();
    assert.equal(page.calls.filter(call => call.url === "/health").length, 2);
    assert.match(page.node("[data-config-summary]").textContent, /通过/);
    assert.equal(page.node('[data-action="add-target"]').disabled, false);
});

test("explicit close and Escape discard unsaved popup edits but refreshing keeps drafts", async () => {
    const page = managedPage(); await page.settle(); openTarget(page);
    popupEdit(page, "name", "cancelled-name"); popupAction(page, "editor-close").listeners.click(); openTarget(page);
    assert.equal(popupField(page, "name").value, "daily-checkin");
    popupEdit(page, "name", "escape-name"); page.node("[data-target-editor]").listeners.cancel({ preventDefault() {} }); openTarget(page);
    assert.equal(popupField(page, "name").value, "daily-checkin");
    popupEdit(page, "name", "keep-draft"); page.node('[data-action="refresh"]').listeners.click(); await page.settle();
    assert.equal(popupField(page, "name").value, "keep-draft");
});

test("a persisted target with id new edits itself rather than becoming a create form", async () => {
    const target = { ...catalogTarget, id: "new", target_binding: '["new","[\\"fixture/team\\",\\"Checkin.yml\\",\\"main\\"]"]' };
    const item = { ...catalogItem, id: "new" };
    const page = managedPage(async () => targetReply(target), async (_url, options) => options.method === "GET" ? catalogReply([item])
        : Response.json({ status: "TARGET_INVALID" }, { status: 400 }));
    await page.settle(); openTarget(page, "new");
    assert.equal(popupField(page, "name").value, "daily-checkin");
    const form = findNode(page.node("[data-target-editor]"), "scheduleForm", "new"); form.listeners.submit({ preventDefault() {} }); await page.settle();
    const body = JSON.parse(page.calls.find(call => call.url === "/api/admin/catalog" && call.options.method === "POST").options.body);
    assert.equal(body.target.id, "new"); assert.equal(body.target.repository, "fixture/team");
});

test("compact rows keep schedule and plan in one collapsed disclosure with readable long-gap units", async t => {
    for (const [gap, text] of [[2880, /固定时段 1 个.*自动最小间隔 2 天/], [120, /固定 1 次\/天.*自动最小间隔 2 小时/]]) await t.test(String(gap), async () => {
        const target = { ...catalogTarget, schedule: { mode: "fixed", times: ["08:30"], min_interval_minutes: gap },
            schedule_date: "2026-11-12", slots: [{ at: "2026-11-12T00:30:00.000Z", attempted: false, result: "PLANNED" }] };
        const page = managedPage(async () => targetReply(target)); await page.settle();
        const article = findNode(page.node("[data-targets]"), "targetId", "primary");
        const description = article.children[0].children[0];
        const disclosures = description.children.filter(item => item.tagName === "DETAILS");
        assert.equal(disclosures.length, 1);
        assert.notEqual(disclosures[0].open, true);
        assert.match(textTree(disclosures[0]), text);
        assert.match(textTree(disclosures[0]), /当前执行计划.*2026-11-12.*08:30.*待执行/);
        assert.ok(!description.children.some(item => item.tagName === "P" && item.textContent.includes("生效排期")));
        if (gap > 1440) assert.ok(!textTree(disclosures[0]).includes("1 次/天"));
    });
});
