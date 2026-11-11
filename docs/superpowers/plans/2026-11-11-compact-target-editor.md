# Compact Target Editor Implementation Plan

> **For agentic workers:** Execute in this session with test-first checkpoints. The user explicitly selected the existing compact-list popup preview and requested direct implementation, not another design cycle.

**Goal:** Manage repositories, refs, workflows and schedules from a compact authenticated list and target-specific popup, with persisted settings and minute/hour/day interval inputs.

**Architecture:** Use the existing SCHEDULES SQLite namespace for a bounded revision-checked target catalog and existing per-target execution records. Every execution resolves current catalog definitions; legacy variables are imported once when frontend management is first opened. Secrets remain in Worker bindings; public responses expose only eligible credential names. Target-local reconciliation preserves same-identity dispatch checkpoints/receipts and adopts new catalog revisions before scheduling.

**Tech Stack:** Existing Workers JavaScript, Durable Object SQLite KV, native Node tests, installed local Playwright. No dependencies, new bindings, GitHub enumeration, real dispatch or browser credential storage.

**Requirements:** Approved conversation and compact-scheduler.html popup preview, 2026-11-11. No comparison editor; repository/ref/workflow remain visible on list. No implementation commit/push/deployment without separate approval.

## Global Constraints
- Keep current Cookie/CSRF/Origin checks, 1024-byte mutation body bound, manual UUID receipts and30-second cooldown, history20 and no unknown-delivery retries.
- Catalog max100targets, monotonic safe revisions, strict existing target field validation, display name1..64characters. New targets use generated stable IDs; IDs cannot be edited.
- Credential values remain Cloudflare Secrets. List only names matching GITHUB_TOKEN/GITHUB_TOKEN_* with valid token syntax; never return secret values or offer reserved bindings.
- When no catalog exists, existing variable behavior remains. Frontend catalog bootstrap imports valid legacy targets once; absent variable initializes empty catalog. Malformed variable/corrupt catalog fails closed, not empty fallback. Existing controls/overrides/plans survive import.
- Updating identity invalidates old settings/plan binding; persisted receipts/history are never erased. Changes do not revoke requests already committed/in flight; target reads/alarms reconcile new config before later dispatch.
- Interval canonical storage remains integer minutes; input units minute/hour/day. Range1minute..365days. Above1day supports one planned slot per day/window; future plans respect known earliest automatic attempt. Manual timing remains independent.
- All clock times Asia/Shanghai. Fixed/random modes, no cross-midnight windows, daily1..24times otherwise preserved. Pause/save never dispatch immediately or catch up.
- Work existing checkout, preserve AGENTS/.planning/reuse guide/localmain/origin. No real subscriptions/logins/GitHub dispatch/bot sends/deployment/cleanup.

### Task 1: Interval Bounds and Long-Gap Planning
**Files:** config.mjs, scheduling.mjs, worker.mjs, schedule-intervals.test.mjs, schedule-settings.test.mjs.
- [x] RED: normalize one-slot2day fixed/random, reject multi-slot>day, max365days, keep default1canonical and old spacing cases.
- [x] Update shared integer bound and capacity branch; long intervals allow only one slot, use automatic guard's next-allowed horizon when planning future days.
- [x] GREEN: existing interval/worker/settings tests plus long-gap alarm test; no network requests in fixtures.

### Task 2: Persisted Catalog and Current-Target Resolution
**Files:** new target-catalog.mjs and target-catalog.test.mjs; worker.mjs/admin.mjs/status.mjs and connected fixtures.
**Interfaces:** readCatalog(env)->null|{version,revision,items}; resolveTargets(env)->validated decorated targets. POST catalog save body{revision,target}; catalog initialization authenticated. Internal /catalog/read and /catalog/save use existing class without recursion into target dispatch.
- [x] RED: bootstrap/restart/legacy preservation, missingconfig empty, stale revisions, reserved/invalid credential refs, invalid repository/ref/workflow, duplicate targets and malformed storage.
- [x] Persist catalog atomically in one key, target revision increments only changed target, stable ID. All admin/DO/cron paths resolve database first, legacy only before import.
- [x] Reconcile target revision with same-identity settings/control preservation on import, intentional edit adoption thereafter; preserve guard/receipts/history, rebuild only changed plans. Errors forbid dispatch and never expose records/secrets.
- [x] GREEN: actual Worker integration edit/restart/dispatch-binding tests, Cookie/CSRF and atomic-write failure tests; full Node suite.

### Task 3: Compact List and Native Settings Dialog
**Files:** admin-ui.mjs/admin-ui.test.mjs, optional small target-editor-ui.mjs for shell styles/content only if needed.
- [x] RED: target popup context, catalog create/update payload+revision, cancelled/late responses, minute/hour/day conversion, settings attached only to clicked target, no browser storage.
- [x] Keep approved compact layout with visible repo/ref/workflow and nexttime/status/settings/run. Settings dialog has basic and schedule tabs, header shows target identity; no page-bottom editor or comparison.
- [x] Catalog fetch/init once after authenticated health check; existing read/edit compatibility retained. Credential dropdown uses safe references only. Drafts/revision conflicts and ambiguous saves read back without resubmission; logout closes dialog and clears sensitive state.
- [x] Native fixed time add/delete, randomcount/window and interval numeric+unit. Save all target fields and schedule in one revision-bound catalog request; source data from effective target, not stale variable defaults.
- [x] GREEN: UI/auth/status suites and dummy Chromium desktop320390 dialog create/edit/save/cancel/conflict/restart readback.

### Task 4: Connected Acceptance and Guides
**Files:** README.md, cloudflare/README.md, docs/configuration.md; ignored native/browser helpers.
- [x] Full Node/Python regressions, syntax, Wrangler dry-run and docs JSON/fences/diff checks.
- [x] Native SQLite catalog+target persistence/restart and Cookie/CSRF/revision/identity updates; block all external calls.
- [x] Inspect compact desktop/mobile screenshots and popup target context. Bounded code review and mutation check on trust-boundary regression.
- [x] Explain no repository JSON required after import, credential bindings and admin security remain, DB/source/reset implications, long interval/queue timing and rollback limitations. Deliver local result, no publication.
