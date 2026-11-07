import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import worker from "../src/worker.mjs";
import { authorized } from "../src/admin.mjs";
import { tokenFor } from "../src/config.mjs";

crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const env = { DEBUG_ACCESS_TOKEN: "dummy_entry_" + "x".repeat(40),
    ADMIN_USERNAME: "test-admin", ADMIN_PASSWORD: "dummy-password-for-tests" };
const basic = (username = env.ADMIN_USERNAME, password = env.ADMIN_PASSWORD) =>
    "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

test("configured selector opens login but fixed token and bearer cannot bypass it", async () => {
    assert.equal((await worker.fetch(new Request("https://login.test/"), env)).status, 200);
    const response = await worker.fetch(new Request(`https://login.test/${env.DEBUG_ACCESS_TOKEN}`), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-access-username/);
    assert.match(html, /data-access-input/);
    assert.ok(!html.includes(env.ADMIN_PASSWORD) && !html.includes(env.ADMIN_USERNAME));
    assert.equal((await worker.fetch(new Request("https://login.test/token"), env)).status, 404);
    assert.equal((await worker.fetch(new Request("https://login.test/health", {
        headers: { Authorization: `Bearer ${env.DEBUG_ACCESS_TOKEN}` } }), env)).status, 401);
});

test("independent Basic credentials authenticate health without revealing configuration secrets", async () => {
    const response = await worker.fetch(new Request("https://login.test/health", {
        headers: { Authorization: basic() } }), env);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(env.ADMIN_PASSWORD));
    for (const header of [basic("other"), basic(undefined, "incorrect-password"), "Basic !!!", "Basic " + Buffer.from("no-colon").toString("base64")]) {
        assert.equal(await authorized(new Request("https://login.test/", { headers: { Authorization: header } }), env), false);
    }
});

test("unicode credentials and password colons are compared exactly; missing credentials fail closed", async () => {
    const unicode = { ...env, ADMIN_USERNAME: "管理", ADMIN_PASSWORD: "测试:密码:abcdefghijkl" };
    assert.equal(await authorized(new Request("https://login.test/", { headers: {
        Authorization: basic(unicode.ADMIN_USERNAME, unicode.ADMIN_PASSWORD) } }), unicode), true);
    for (const ADMIN_PASSWORD of [undefined, "", "short", "x".repeat(257), "x".repeat(12) + "\n"]) {
        const missing = { ...env, ADMIN_PASSWORD };
        assert.equal(await authorized(new Request("https://login.test/", { headers: { Authorization: basic() } }), missing), false);
        const entry = await worker.fetch(new Request(`https://login.test/${env.DEBUG_ACCESS_TOKEN}`), missing);
        assert.equal(entry.status, 200, "Entry should explain missing login configuration, not disappear");
        assert.match(await entry.text(), /ADMIN_USERNAME.*ADMIN_PASSWORD/);
    }
});

test("admin login variables can never be dispatched as GitHub PATs", () => {
    for (const token_secret of ["ADMIN_USERNAME", "ADMIN_PASSWORD"])
        assert.equal(tokenFor({ token_secret }, { [token_secret]: "dummy_value_" + "x".repeat(40) }), null);
});
