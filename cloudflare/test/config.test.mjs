import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig, tokenFor } from "../src/config.mjs";

const target = { id: "a", repository: "owner/repo", workflow: "Checkin.yml", ref: "main",
    token_secret: "GITHUB_TOKEN_A", enabled: true };

test("configuration identifiers reject terminal whitespace before log or URL construction", () => {
    for (const field of ["id", "repository", "workflow", "ref", "token_secret"]) {
        for (const suffix of ["\n", "\r", "\r\n", " ", "\t"]) {
            assert.throws(() => parseConfig(JSON.stringify({ version: 1,
                targets: [{ ...target, [field]: target[field] + suffix }] })), /CONFIG_INVALID/, `${field} ${JSON.stringify(suffix)}`);
        }
    }
});

test("PAT binding values reject terminal whitespace instead of accepting malformed headers", () => {
    for (const suffix of ["\n", "\r", "\r\n", " ", "\t"]) {
        assert.equal(tokenFor(target, { GITHUB_TOKEN_A: "github_pat_dummy_token" + suffix }), null);
    }
    assert.equal(tokenFor(target, { GITHUB_TOKEN_A: "github_pat_dummy_token" }), "github_pat_dummy_token");
});
