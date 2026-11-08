# Cloudflare Multiple Schedules and Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add daily fixed/random multi-slot schedules, revocable refresh-persistent sessions and a visual configuration check page.

**Architecture:** Keep SCHEDULES and per-target alarms, add a focused scheduling module and a separately named authentication object handled by a sessions module. The configuration parser remains authoritative; an inspection view reuses its validators. Root owns shared backend integration; independent session and frontend workers own non-overlapping files.

**Tech Stack:** Existing Workers JavaScript, Web Crypto, Durable Object storage, Node test runner, HTML/CSS and VM UI tests. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-08-cloudflare-multiple-schedules-session-design.md`

## Global Constraints

- Time zone Asia/Shanghai; minute precision; daily count/list length1..24; random count cannot exceed available minutes.
- Omitted schedule keeps once-per-day01:00..23:00 and existing saved time. No cross-day window, cumulative quota, online JSON editor or additional Cron.
- Fixed session lifetime12hours, max128active records; Secure/HttpOnly/SameSiteStrict host cookie; server-generated HMAC key; no browser credential storage.
- Keep Basic API support, default enabled controls, manual UUID receipts/30second cooldown,20history cap and UNKNOWN-before-HTTP no resend.
- No live subscriptions/nodes/logins/bot sends/GitHub dispatch/manual deployment or push. User declined worktrees; preserve current branch/localmain/origin/AGENTS/planning.
- No concurrent edits to a shared file. Root integrates worker.mjs/admin.mjs/config.mjs; workers do not commit shared state. Final code review before completion.

---

### Task1: Configuration and Durable Multi-Slot Planner (Root)

**Files:** Modify config.mjs/worker.mjs/admin.mjs; create scheduling.mjs and test/schedules.test.mjs; adapt affected worker/admin tests.

**Interfaces:**
- `normalizeSchedule(value, field="schedule")` -> canonical fixed `{mode:"fixed",times:[HH:mm]}` or random `{mode:"random",count,window:{start,end}}`, throws CONFIG_INVALID with sanitized diagnostic.
- `scheduleFor(target)` -> explicit normalized schedule or legacy default; `targetBinding` remains repository identity.
- `inspectConfig(raw,env)` -> safe items `{index,id,repository,workflow,ref,token_secret,enabled,schedule,error}` with null placeholders for invalid values; never raw config values that fail validators.
- scheduling exports `DAY`, `MINUTE`, `localDate(now)`, `dayStart(date)`, `nextDate(date)`, `randomMinute(size=1321)`, `planBinding(target)`, `validPlan(plan)`, `migratePlan(plan,target)`, `createPlan(target,previous,now,afterPrevious)` and `pendingSlot(plan)`.
- Planv2 `{version:2,id,binding,date,slots:[{at,attempted,result,history_id?,notification?}],last?}`; no top-level at/attempted mirror.
- Public target state adds `schedule`, `schedule_date`, `slots:[{at:ISO,attempted,result}]`; existing next_run/history/error remain.

- [x] Add parser tests fixed sort/duplicates/count/window/types and actual object tests3fixed dispatches,3random samples,24cap and no HTTP from read/initialization.

```js
assert.equal(parseConfig(raw({mode:"random",count:3,window:{start:"09:00",end:"22:00"}}))[0].schedule.count,3);
await object.fetch(initRequest);
assert.equal(values.get("plan").slots.length,3);
assert.equal(http.mock.callCount(),0);
```

- [x] Run `node --test cloudflare/test/schedules.test.mjs`; record expected RED for absent schedule support.
- [x] Validate schedule separately, reject extra fields and terminal whitespace; canonicalize fixed sorted list. Keep omission absent in returned target to distinguish legacy initialization.
- [x] Extract date/sample/plan validation into scheduling.mjs; sample unique minute indexes by bounded draws from a shrinking pool, sort timestamps.
- [x] Convert v1 saved slot without redraw when schedule is legacy-equivalent; keep mismatched binding to force future replan on changed schedule.
- [x] Change initialize/describe/alarm to use slots. Persist attempted/UNKNOWN+history before HTTP; one callback submits at most latest due slot, skips older overdue ones; no cross-date catch-up.
- [x] Keep enabled and manual receipt bindings independent of planBinding. Reopen skips due slots; manual run leaves slots unchanged.
- [x] Add loss/retry/migration/config-change controls and adapt old single-slot fixture inspections, never add production branches for tests.
- [x] Run focused planner/admin tests and review backend scope before final integration.

### Task2: Session Module (Independent Worker) and Authentication Integration (Root)

**Files:** Worker owns new sessions.mjs/test/sessions.test.mjs only. Root modifies admin.mjs/worker.mjs and adds integration tests.

**Interfaces:**
- `sessionApiResponse(request,env,basicAuthorized)` -> Response or null; public GET `/api/admin/session`, POST `/api/admin/session/login`, POST `/api/admin/session/logout`.
- `sessionStorageResponse(request,ctx,env,basicAuthorized)` -> Response or null for `/session/login`, `/session/check`, `/session/logout`; delegate using separately named object `auth:v1` via existing SCHEDULES. Internal requests retain original origin/host, never trust user-provided forwarding headers.
- `sessionAuthorized(request,env)` -> boolean, throws safe STATE_INVALID/STORAGE_UNAVAILABLE on storage failure. Cookie mutations enforce same-origin Origin and `X-CSRF-Token`.
- Login/check JSON `{status:"AUTHENTICATED",expires_at:ISO,csrf_token:string}`, logout `{status:"SIGNED_OUT"}`; errors use existing safe statuses plus SESSION_LIMIT.
- POSTlogin uses correct Basic and empty JSONobject; no CSRF needed before login but exact Origin required. Check is read-only. Logout uses cookie+CSRF and empty JSONobject.

- [x] Write tests with storageMap and native WebCrypto: cookie properties, reload, nonce/signature/expiry/host tamper, credential rotation, revoked copied token, independent sessions and capacity128.

```js
const response=await sessionApiResponse(loginRequest,env,basicAuthorized);
assert.equal((await response.clone().json()).status,"AUTHENTICATED");
assert.match(response.headers.get("Set-Cookie"),/HttpOnly/);
```

- [x] Run focused new test and record RED before implementation.
- [x] Generate256bit signing key on first valid login only; store private key metadata and hashed active records, reject corrupt key/records, prune expired records only on login.
- [x] HMAC covers version/nonce/expiry/host/current credential identity using server key; derive CSRF with domain separation. Bound all payload/cookie sizes and authenticate MAC before trusting fields.
- [x] Return no raw exceptions, key, Cookie or credentials in JSON. Failed revoke does not claim logout; no expiration Alarm.
- [x] Root splits `basicAuthorized` from existing `authorized`; gate cookies through sessionAuthorized and map storage exceptions503, keep Basic unchanged.
- [x] Root delegates session object handlers before target routing, forwards real-origin cookie/CSRF safely to target DOs; no forged internal-authorization bypass.
- [x] Verify end-to-end cookie health/targets/toggle/manual rejection/CSRF/logout with all external fetch mocked; independent review session scope.

### Task3: Browser Session UX and Visual Configuration (Independent Worker)

**Files:** Own admin-ui.mjs/status.mjs/test/admin-ui.test.mjs plus focused frontend tests. Do not edit shared config/worker/admin files.

**Interfaces:** Consume public session API from Task2, target slots from Task1, and `inspectConfig` from config.mjs. Status adds `config.items`; config.state/error and existing aggregate readiness stay available. Use session cookie with `credentials:"same-origin"`, CSRF memory only, Basic only during login.

- [x] Write VM/browser-facing tests for initial bootstrap GETsession401, authenticated reload with no password input, login cookie exchange, failed revoke, late replies and mutation CSRF header.

```js
assert.equal(page.calls[0].url,"/api/admin/session");
assert.equal(page.calls[0].options.credentials,"same-origin");
assert.equal(page.node("#trigger-admin").hidden,false);
```

- [x] Record RED; implement boot/login/logout without localStorage/sessionStorage/document.cookie or credential retention. Keep late-response session generation guard and uncertain manual UUID behavior.
- [x] Build four semantic readiness panels and per-target inspection rows using textContent, validated fields, count/time badges and folded technical details. Do not claim token permission or delivery verification.
- [x] Display actual future slots on repository page and update static sidebar assumptions; keep logs only in logs section.
- [x] Handle invalid JSON as unknown/no rows, per-target invalid values as null/placeholder plus safe error field; never permit actions from partial valid rows.
- [x] Use existing style variables; responsive mobile table/cards, keyboard focus and reduced motion. Preserve color/typography rather than restyling unrelated pages.
- [x] Run focused UI/status/entry/login tests and verify a local dummy screenshot without business requests; review task scope.

### Task4: Connected Verification and Documentation (Root)

**Files:** README.md/cloudflare/README.md/docs/configuration.md and only integration fixtures needed by changed contracts.

- [x] Integrate the3deliverables, ensure no overlapping writes and document rulings in selected planning directory.
- [x] Run `node --test cloudflare/test/*.test.mjs` and `.venv/Scripts/python.exe -m unittest discover -s tests`; preserve all Python behavior.
- [x] Run Wrangler dry-run with metrics disabled, actionlint, Python3.11grammar, Markdown JSON/fences and git diff checks.
- [x] Review session/core/UI through spec+quality reviewers, fix actionable findings with targeted regressions, repeat final full suite.
- [x] Update concise configuration examples for fixed/random schedules,12hour sessions, upgrade/rollback cautions and native copying; no raw credentials.
- [x] Keep runtime changes local and report actual test evidence. Publication/manual deployment requires user instruction; original untracked files and original branch remain.

## Verified Local Result

213 Cloudflare and 367 Python tests pass. Native Workerd/SQLite session restart, revocation, CSRF and Basic checks pass with zero external fetches; dummy desktop/mobile/keyboard UI QA passes. Wrangler dry-run119.41KiB, syntax/3.11grammar/actionlint/Bash/Markdown JSON+fences/diff checks pass. All scoped and final spec/quality reviews approve; no deferred findings. Changes remain uncommitted and unpublished.
