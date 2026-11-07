import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

test("actual Wrangler bundle emits a self-contained runnable browser bootstrap", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const out = mkdtempSync(join(tmpdir(), "trigger-bundle-test-"));
    try {
        execFileSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
            "deploy", "--dry-run", "--outdir", out], { cwd: root,
            env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe", timeout: 60_000 });
        const { default: worker } = await import(pathToFileURL(join(out, "worker.js")));
        const response = await worker.fetch(new Request("https://bundle.test/admin/client.js"), {
            DEBUG_ACCESS_TOKEN: "dummy_access_" + "x".repeat(40) });
        assert.equal(response.status, 200);
        const script = await response.text();
        assert.doesNotThrow(() => runInNewContext(script, { URLSearchParams,
            location: { hash: "", pathname: "/token", search: "" },
            history: { replaceState() {} }, document: { querySelector() { return null; } } }),
        "Browser code must not depend on worker-scoped bundler helpers");
    } finally {
        assert.equal(resolve(out).startsWith(resolve(tmpdir()) + "/") || resolve(out).startsWith(resolve(tmpdir()) + "\\"), true);
        rmSync(out, { recursive: true, force: true });
    }
});
