import assert from "node:assert/strict";
import { test } from "node:test";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/worker.mjs";

const access = "dummy_access_" + "x".repeat(40);
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
test("root only greets; fixed token path opens private-data-free credential entry", async (t) => {
    t.mock.method(globalThis, "fetch", () => assert.fail("Entry must not make external calls"));
    const env = { DEBUG_ACCESS_TOKEN: access, TRIGGER_CONFIG: "private_marker",
        SCHEDULES: { idFromName() { assert.fail("Entry must not read objects"); } } };
    const root = await worker.fetch(new Request("https://entry.test/"), env);
    assert.equal(await root.text(), "hello world");
    const response = await worker.fetch(new Request("https://entry.test/token"), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-access-input/);
    assert.match(html, /admin\/client\.js/);
    assert.ok(!html.includes(access) && !html.includes("private_marker"));
    assert.equal((await worker.fetch(new Request("https://entry.test/token"), {})).status, 404);
    const head = await worker.fetch(new Request("https://entry.test/token", { method: "HEAD" }), env);
    assert.equal(await head.text(), "");
    assert.equal((await worker.fetch(new Request("https://entry.test/token", { method: "POST" }), env)).status, 405);
});

test("configuration overview is authentication-only and never dispatches", async (t) => {
    t.mock.method(crypto.subtle, "timingSafeEqual", (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b)));
    const env = { DEBUG_ACCESS_TOKEN: access };
    assert.equal((await worker.fetch(new Request("https://entry.test/health"), env)).status, 401);
    const response = await worker.fetch(new Request("https://entry.test/health", { headers: {
        Authorization: `Bearer ${access}` } }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).config.state, "missing");
});
