import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const packageRoot = new URL("../", import.meta.url);

function readJson(name) {
    const path = new URL(name, packageRoot);
    assert.ok(existsSync(path), `Deployment artifact is missing: ${name}`);
    return JSON.parse(readFileSync(path, "utf8"));
}

test("the deployment binds the exported scheduler to a SQLite namespace", async () => {
    const config = readJson("wrangler.jsonc");
    assert.equal(config.name, "agentrouter-trigger");
    assert.equal(config.main, "src/worker.mjs");
    assert.deepEqual(config.durable_objects.bindings, [
        { name: "SCHEDULES", class_name: "TriggerSchedule" },
    ]);
    assert.deepEqual(config.migrations, [
        { tag: "v1", new_sqlite_classes: ["TriggerSchedule"] },
    ]);
    const worker = await import(new URL(config.main, packageRoot));
    assert.equal(typeof worker.TriggerSchedule, "function");
    assert.equal(typeof worker.TriggerSchedule.prototype.fetch, "function");
    assert.equal(typeof worker.TriggerSchedule.prototype.alarm, "function");
    assert.equal(typeof worker.default.fetch, "function");
    assert.equal(typeof worker.default.scheduled, "function");
});

test("deployment preserves dashboard vars without shipping runtime credentials or enabled targets", () => {
    const config = readJson("wrangler.jsonc");
    assert.equal(config.keep_vars, true);
    for (const key of ["vars", "account_id", "secrets", "env"]) {
        assert.equal(Object.hasOwn(config, key), false, `${key} must stay dashboard-managed`);
    }
    assert.equal(config.workers_dev, true);
    assert.equal(config.preview_urls, false);
    assert.equal(Object.hasOwn(config, "routes"), false);
});

test("the initializer cron runs at Shanghai 00:05 rather than starting an Actions wait", () => {
    const config = readJson("wrangler.jsonc");
    assert.deepEqual(config.triggers, { crons: ["5 16 * * *"] });
    assert.equal(config.compatibility_date, "2026-11-07");
});

test("npm scripts use the local pinned Wrangler and the built-in test runner", () => {
    const pkg = readJson("package.json");
    assert.equal(pkg.private, true);
    assert.equal(pkg.type, "module");
    assert.equal(pkg.engines.node, ">=22");
    assert.deepEqual(pkg.scripts, {
        test: "node --test test/*.test.mjs",
        deploy: "wrangler deploy",
        check: "wrangler deploy --dry-run",
    });
    assert.deepEqual(pkg.devDependencies, { wrangler: "4.158.0" });
    assert.deepEqual(pkg.dependencies ?? {}, {});
});

test("the lockfile pins the same package and public-registry Wrangler dependency", () => {
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.version, pkg.version);
    assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
    assert.deepEqual(lock.packages[""].engines, pkg.engines);
    assert.equal(lock.packages["node_modules/wrangler"].version, "4.158.0");
    assert.equal(lock.packages["node_modules/wrangler"].resolved,
        "https://registry.npmjs.org/wrangler/-/wrangler-4.158.0.tgz");
    for (const [name, dependency] of Object.entries(lock.packages)) {
        if (!name) continue;
        const url = new URL(dependency.resolved);
        assert.equal(url.origin, "https://registry.npmjs.org");
        assert.equal(url.username, "");
        assert.equal(url.password, "");
        assert.match(dependency.integrity, /^sha512-/);
    }
});

test("a fresh deployment with no dashboard variables stays inert and exposes no public trigger", async (t) => {
    const config = readJson("wrangler.jsonc");
    const { default: worker } = await import(new URL(config.main, packageRoot));
    const fetch = t.mock.method(globalThis, "fetch", () => {
        assert.fail("Missing runtime configuration must never send an HTTP request");
    });
    const env = {
        SCHEDULES: {
            idFromName() { assert.fail("No targets means no Durable Object initialization"); },
        },
    };
    const pending = [];
    const ctx = { waitUntil(value) { pending.push(value); } };
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 7, 16, 5), cron: "5 16 * * *" }, env, ctx);
    await Promise.all(pending);
    for (const method of ["GET", "POST"]) {
        const response = await worker.fetch(new Request("https://trigger.invalid/trigger", { method }), env, ctx);
        assert.equal(response.status, 404);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test("the Worker imports without files or dependencies outside the cloned subdirectory", async () => {
    const tempRoot = resolve(tmpdir());
    const isolated = mkdtempSync(join(tempRoot, "agentrouter-trigger-"));
    try {
        cpSync(new URL("src/", packageRoot), join(isolated, "src"), { recursive: true });
        const { default: worker } = await import(pathToFileURL(join(isolated, "src", "worker.mjs")));
        assert.equal((await worker.fetch(new Request("https://trigger.invalid/"), {})).status, 200);
        await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 7, 16, 5) }, {});
    } finally {
        assert.equal(dirname(isolated), tempRoot);
        rmSync(isolated, { recursive: true, force: true });
    }
});
