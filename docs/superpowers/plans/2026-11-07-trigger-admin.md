# Trigger Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved secure administration page with persisted switches, actual schedule display, bounded history and independent manual dispatch.

**Architecture:** One existing SQLite-backed SCHEDULES object per target retains plan plus control/history/idempotency receipts. Public worker performs authentication before object access; same-origin browser client reads private target state only after Bearer verification.

**Tech Stack:** Worker ES modules, Web Crypto, Durable Object KV over SQLite, Node built-in tests, existing pinned Wrangler and local Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-trigger-admin-design.md`

## Global Constraints

- Access Secret DEBUG_ACCESS_TOKEN: 32-128 URL-safe ASCII chars, absent/empty/invalid closes admin feature.
- Visible history cap 20; manual UUID receipt retention 24h with cap 100 and new-request cooldown 30s.
- JSON mutation bodies <=1024 UTF-8 bytes, auth before DO access, Origin absent or exact same origin.
- No real dispatch/bots/deploy/login, no dependency addition, no old GitHub cron deletion.
- Preserve existing uncommitted status/WeCom files. Agents do not commit/push; root owns combined reviewed delivery to yidu456/main.

### Task 1: Authenticated State And Manual Dispatch

**Files:** Create `cloudflare/src/admin.mjs`, `cloudflare/test/admin.test.mjs`; modify `cloudflare/src/worker.mjs`, `cloudflare/src/wecom.mjs`, existing WeCom/worker tests only where connected.

**Interfaces:** `adminState(env)` returns disabled/invalid/configured; `authorized(request,env)` async boolean; `adminResponse(request,env)` returns Response or null for non-admin paths. Public `/api/admin/targets` and four POST paths exactly match spec. Internal DO `/admin/state`, `/admin/enabled`, `/admin/run`, `/admin/logs/delete`, `/admin/logs/clear` use id query and validated JSON; internal access also checks Bearer. Preserve parser exports and existing TriggerSchedule public class/API. `sendTriggerNotification(target,date,result,env,source='automatic')` extends helper without breaking old callers.

- [x] Write RED auth/gating/body/Origin/privacy tests, plus serialized storage fixtures with get/put/delete/getAlarm/setAlarm/deleteAlarm.
```js
const response = await worker.fetch(new Request('https://unit.test/api/admin/targets'), env);
assert.equal(response.status, 401);
assert.equal(namespaceCalls, 0);
```
- [x] Run `node --test cloudflare/test/admin.test.mjs`, confirm missing route behavior failures, then add minimal auth/admin router.
- [x] Add RED tests for effective persisted overrides, JSON false reopening via cron, read-only next-run, manual before-HTTP UNKNOWN, UUID retry after visible deletion, cap/cooldown, secret redaction and automatic history.
```js
const before = structuredClone(await storage.get('plan'));
await runWithUuid(uuid);
await clearHistory();
await runWithUuid(uuid);
assert.equal(githubCalls, 1);
assert.deepEqual(await storage.get('plan'), before);
```
- [x] Extend shared dispatch and notification path; keep plan/history writes crash conservative, add known schemas and binding checks.
- [x] Run full Node suite; preserve old automatic schedule/dedup tests and write task report with RED/GREEN and exact API/data shape.
- [x] Root reviews task diff before next implementer; no task commit until combined verification.

### Task 2: Real Management Interface

**Files:** Create `cloudflare/src/admin-ui.mjs`, `cloudflare/src/admin-client.js`, `cloudflare/test/admin-ui.test.mjs`; modify `cloudflare/src/status.mjs`, `cloudflare/src/admin.mjs` static client route, `cloudflare/test/status.test.mjs` only connected cases.

**Interfaces:** `adminShell()` returns static private-data-free HTML body; client bootstrap only added when adminState configured. Worker `/admin/client.js` serves imported text `ADMIN_CLIENT` from admin-ui.mjs or reads static client via module string (no runtime fs). Prefer client exported function `adminClient()` converted to script text with toString, keeping module import dependency free. `/` remains public shell, fragment token consumed synchronously, authenticated GET then render. Admin response data spec travels from Task1 report. Pure render helpers may export to tests.

- [x] Write RED tests for shell injection only with configured access Secret, no target/PAT/name leakage, restrictive script/connect CSP and content headers.
```js
const html = await response.text();
assert.ok(!html.includes(env.GITHUB_TOKEN_A));
assert.match(html, /admin\/client\.js/);
```
- [x] Implement preview styling and real client: build text with textContent/escape, no innerHTML of untrusted strings; native confirmations, live feedback, actual Asia/Shanghai dates, mode default counters labeled as defaults, switches and history CRUD.
- [x] Implement in-memory Token/no browser storage, no query credential, request id reuse only for uncertain transport, bounded errors, busy actions, auth expiry clears private UI, explicit logout.
- [x] Run Node tests and local Playwright mocked API fixtures checking fragment erased before first authenticated request, no unauthorized repo render, toggle/refresh/next times, confirm/cancel/run/log cap/deletion, 320/390/736/1024 layouts and zero real business network.
- [x] Root reviews task diff and native browser evidence; no commit until combined delivery.

### Task 3: Docs, Native Verification And Main Delivery

**Files:** Modify `README.md`, `cloudflare/README.md`, `cloudflare/API-TOKENS.md`, `docs/cloudflare-trigger-design.md`; ignored native smoke/browser QA under `.superpowers/`; task specs/plans tracked.

- [x] Update configuration guide with independent admin Secret generation via `crypto.randomBytes(32).toString('base64url')`, fragment link, no mode/D1, override precedence/reset on binding change, restart persistence, 20 logs, receipt retention/cooldown, deletion limits and accepted-not-final-success.
- [x] Extend native manifest with all ES imports and static client module. Dummy external service intercepts GitHub and WeCom. Verify persisted switches/history/receipts survive Miniflare dispose/restart, auth refuses before namespace effects, old plans survive, manual repeated UUID after clear has one upstream request and unchanged plan.
```js
assert.deepEqual(await readPlanAfterManual(), automaticPlanBefore);
assert.equal(upstreamRequests.filter(x => x.github).length, 1);
```
- [x] Run `npm test --prefix cloudflare`, `.venv/Scripts/python.exe -m unittest discover -s tests`, Python compile, Bash/actionlint where installed, docs JSON/link checks, `git diff --check`, `npm run check --prefix cloudflare` with telemetry disabled.
- [x] Request broad independent security/concurrency/privacy/spec/quality review. Resolve actionable findings with tests and scoped rereview.
- [ ] Check `git ls-remote yidu456 refs/heads/main`, fetch if necessary, prove remote main ancestor HEAD; stage exactly owned code/tests/docs/spec/plan, exclude AGENTS/.planning/.superpowers. Commit `feat: add authenticated trigger management` and push `git push yidu456 HEAD:main` without force; verify remote SHA equals HEAD.
- [ ] Mark phases 21/23 complete only when checks/review/push actually pass; report actual URL retrieval and setup instructions without inventing a deployed domain.
