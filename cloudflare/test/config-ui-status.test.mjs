import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationStatus } from "../src/status.mjs";

const target = { id: "fixture", repository: "fixture/repo", workflow: "Checkin.yml", ref: "main",
    token_secret: "GITHUB_TOKEN_A", schedule: { mode: "fixed", times: ["20:30", "08:30"] } };
const env = (targets) => ({ TRIGGER_CONFIG: JSON.stringify({ version: 1, targets }),
    GITHUB_TOKEN_A: "github_pat_secret_marker", ADMIN_PASSWORD: "dummy_admin_password_marker", SCHEDULES: {} });

test("configuration status adds safe per-target inspection and token presence without any secret values", () => {
    const status = configurationStatus(env([target]));
    assert.equal(status.config.state, "valid");
    assert.equal(status.config.items.length, 1);
    assert.equal(status.config.items[0].repository, "fixture/repo");
    assert.equal(status.config.items[0].token_state, "configured");
    assert.deepEqual(status.config.items[0].schedule, { mode: "fixed", times: ["08:30", "20:30"] });
    assert.equal(status.github_tokens.verified, false);
    assert.ok(!JSON.stringify(status).includes("github_pat_secret_marker"));
});

test("partial inspection never enables execution and invalid supplied values become null placeholders", () => {
    const broken = { ...target, ref: "private..invalid_ref_marker", schedule: { mode: "random", count: "private_count_marker",
        window: { start: "09:00", end: "22:00" } } };
    const status = configurationStatus(env([broken]));
    assert.equal(status.config.state, "invalid");
    assert.equal(status.schedule.state, "not_configured");
    assert.equal(status.config.items[0].ref, null);
    assert.equal(status.config.items[0].schedule, null);
    assert.equal(status.config.items[0].repository, "fixture/repo");
    assert.ok(!JSON.stringify(status).includes("private_count_marker"));
    assert.ok(!JSON.stringify(status).includes("private..invalid_ref_marker"));
});

test("broken JSON has no inspectable rows and safe error codes", () => {
    const status = configurationStatus({ TRIGGER_CONFIG: '{"private_invalid_json_marker":' });
    assert.equal(status.config.state, "invalid");
    assert.deepEqual(status.config.items, []);
    assert.deepEqual(status.config.error, { field: "TRIGGER_CONFIG", code: "JSON_SYNTAX" });
    assert.ok(!JSON.stringify(status).includes("private_invalid_json_marker"));
});

test("per-row token readiness distinguishes missing invalid and unsafe names", () => {
    const status = configurationStatus(env([{ ...target, token_secret: "MISSING_TOKEN" },
        { ...target, id: "second", ref: "dev", token_secret: "ADMIN_PASSWORD" },
        { ...target, id: "third", ref: "branch", token_secret: "private_invalid_name_marker" }]));
    assert.deepEqual(status.config.items.map(item => item.token_state), ["missing", "invalid", null]);
    assert.equal(status.config.items[2].token_secret, null);
});
