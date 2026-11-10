# Cloudflare Schedule Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Edit and persist per-target fixed/random schedules and automatic minimum intervals from the current admin page.

**Architecture:** Reuse target Durable Object storage and native alarms. Shared normalization feeds a bounded random planner; authenticated revision-bound writes persist schedule overrides, while an independent automatic checkpoint enforces actual spacing. The current three-section browser client edits only schedules, not credentials or repository identities.

**Tech Stack:** Existing Workers JavaScript, SQLite KV multi-key atomic writes, Web Crypto, native Node tests and local Playwright. No added dependency.

**Spec:** `docs/superpowers/specs/2026-11-09-cloudflare-schedule-editor-design.md`

## Global Constraints

- All times Asia/Shanghai; daily1..24 planned slots; min_interval_minutes integer1..1440, omitted1; canonical1 omits the field.
- Only automatic triggers share spacing; manual UUID receipts/30second cooldown and history20 remain unchanged.
- Database schedule overrides > variable schedule > original random1 01:00..23:00; restoration is explicit, identity-bound and revision-checked.
- No immediate dispatch/catch-up from saves; no reset of trustworthy automatic checkpoint on settings/log/pause/day changes.
- Keep12hour Cookie sessions and CSRF/Origin/body1024byte guards; no browser credential or draft persistence.
- Work in existing user-selected checkout/branch; no commits/push/deploy/business requests/cleanup. Preserve AGENTS/.planning/untracked project-proxy-reuse-guide.md.
- Root owns shared planning and reviews. Implementers edit only assigned files; no subagents. Sequential implementers, scoped reviews after each task, broad review once at end.

---

### Task 1: Interval Normalization and Bounded Planner

**Files:** Modify `cloudflare/src/config.mjs`, `cloudflare/src/scheduling.mjs`; add `cloudflare/test/schedule-intervals.test.mjs`. No other files.

**Interfaces:** Keep normalizeSchedule/scheduleFor/planBinding/createPlan/migratePlan signatures. Add `intervalMinutes(schedule)` returning schedule.min_interval_minutes ??1. Valid result whitelist additionally accepts INTERVAL_SKIPPED. Keep v1/v2 storage shapes; no top-level mirror.

- [x] Add RED tests for integer1..1440, omitted/explicit1 canonical equivalence, fixed cyclic/day spacing, random feasibility and field error codes.

```js
assert.deepEqual(normalizeSchedule({mode:'fixed',times:['09:00'],min_interval_minutes:1}),{mode:'fixed',times:['09:00']});
assert.throws(()=>normalizeSchedule({mode:'random',count:3,window:{start:'09:00',end:'10:00'},min_interval_minutes:60}),/CONFIG_INVALID/);
assert.throws(()=>normalizeSchedule({mode:'fixed',times:['00:15','23:45'],min_interval_minutes:60}),/CONFIG_INVALID/);
```

- [x] Run `node --test cloudflare/test/schedule-intervals.test.mjs`, capture expected failures before source edits.
- [x] Normalize optional interval with SCHEDULE_INTERVAL for invalid type/range, SCHEDULE_SPACING for fixed insufficient spacing, SCHEDULE_CAPACITY for impossible random count/window or daily density. Preserve existing errors/default bindings.
- [x] Generate random minutes from compressed pool size L-(N-1)*(G-1), sample N unique offsets with existing randomMinute, sort and add start+i*(G-1). Return exactlyN slots, no guess/retry loop.

```js
const gap=intervalMinutes(schedule);
const size=end-start+1-(schedule.count-1)*(gap-1);
const pool=Array.from({length:size},(_,i)=>i);
const draws=Array.from({length:schedule.count},()=>pool.splice(randomMinute(pool.length),1)[0]).sort((a,b)=>a-b);
minutes=draws.map((offset,i)=>start+offset+i*(gap-1));
```

- [x] Cover1/24counts, endpoint/capacity boundaries, deterministic fixtures forG1 compatibility, multiple draws, v1 binding migration and validPlan INTERVAL_SKIPPED.
- [x] Run intervals+schedules+worker/config/status tests; write report/diff to this plan's ignored workspace, no commit. Root scoped spec/quality review before Task2.

### Task 2: Persistent Settings, Revision API and Actual Automatic Guard

**Files:** Modify `cloudflare/src/worker.mjs`, `cloudflare/src/admin.mjs`; create `cloudflare/src/schedule-settings.mjs` for pure persisted-record validation/effective state/identity, add `cloudflare/test/schedule-settings.test.mjs`. Adapt atomic-storage fixtures in admin/worker/schedules/session-integration tests only if needed. No UI/config/planner edits without root agreement.

**Interfaces:** Consume Task1 intervalMinutes/normalizeSchedule/createPlan and existing targetBinding/samePlanTarget.
- `settingsBinding(target)` -> JSON.stringify([target.id,targetBinding(target)]).
- `validSettings(value)` strict `{version:1,binding:string,revision:safeInteger>=1,schedule:canonical|null}`.
- `validGuard(value)` strict `{version:1,binding:string,last_at:safeInteger>=0}`.
- `effectiveTarget(target,settings)` -> target with matched non-null override; otherwise original target preserving absent schedule.
- `settingsState(target,settings)` -> `{schedule_source:'database'|'variable',schedule_revision:0|savedRevision,target_binding:settingsBinding(target)}`; mismatched saved identity defaultsrevision0.
- Target public state adds those3 plus `automatic_state:'known'|'unknown'`, `automatic_last_at:ISO|null`, `automatic_next_allowed_at:ISO|null`. Error fallback source/revision null; all fields validated in UI next task.
- API POST `/api/admin/targets/<id>/schedule` body `{binding,revision,schedule}` and `/schedule/reset` body `{binding,revision}`. Valid success `SCHEDULE_UPDATED`/`SCHEDULE_RESET` with actual `target`.400 schedule error `{status:'SCHEDULE_INVALID',error:{field,code}}`;409SCHEDULE_CONFLICT/TARGET_CHANGED;429SCHEDULE_REVISION_LIMIT;503 safe state/storage.

- [x] Add RED actual-worker tests using atomic dummy storage (object-form put updates all keys together) and native WebCrypto; network mocked. Assert settings persistence, precedence, reset tombstone revisions, stale revision/identity and strictbody1024.

```js
const before=(await(await f.call()).json()).targets[0];
await f.call('/a/schedule',{binding:before.target_binding,revision:0,schedule:{mode:'fixed',times:['09:00','18:00'],min_interval_minutes:120}});
assert.equal(f.values.get('schedule_settings').revision,1);
assert.equal(f.http.mock.callCount(),0);
```

- [x] Shared request-body parser handles schedule/reset exact fields and canonical validation. Basic+Cookie protected public/internal routes keep gates; no raw values in responses. Backend checks identity/revision before writes.
- [x] Snapshot reads settings/guard plus existing records and fails closed on corruption. Effective target is used consistently by listing/describe/initialize/select/alarm/reopen/manual settings display. Persist records independent of existing control/receipts/history; no JSON invalid fallback.
- [x] Compute new future plan before writes, keep matchingplan for semantically equal saves. Commit schedule_settings+newplan via singleobject-formput; revisionnull reset stored as tombstone. Arm future only after commit and only enabled+validPAT; missing/disabled stillsavable. PostcommitAlarm failure503 followed by read recovers sametime/revision.
- [x] Restore missing automatic checkpoint only from identity-matching plan linked by history_id to validated sourceautomatic record. Recover latest trustworthy at; unrelated/manual/deleted history unknown. Preserve on settingschanges/reset/logdelete/day/pause.
- [x] Alarm selects at mostlatestdue, skips older as before. Check last_at+gap*60000 before HTTP; conflict => INTERVAL_SKIPPED no notification/HTTP, retain checkpoint and advance futurealarm. Actual attempt stores planUNKNOWN+guard+history in one atomicput beforeHTTP; failure forbidsHTTP. AfterHTTP keepguardattempttime, not completion.
- [x] Test persistence acrossrestart, tomorrowspacing, latecallbackspacing, guardknown/unknown, successful/failing/unknownattempts, manual independence, concurrentrevisionwrite, unchangedsave/reset, PATmissing/disabledsave, atomicfailure/Alarmfailure/pre/postHTTPfailures and logclear.
- [x] Run focused tests+fullNode suite; update honest legacy atomic faultfixtures where API changed (never add productiontesthooks). Root scoped review before Task3.

### Task 3: Browser Editor, Conflict/Draft UX and Effective-State Display

**Files:** Modify `cloudflare/src/admin-ui.mjs`, `cloudflare/src/status.mjs`, `cloudflare/test/admin-ui.test.mjs`; add focused UI test file only if currentfixture can be shared without duplicating hugeharness. No backend/planner edits.

**Interfaces:** Consume Task2publicfields/body/status. `/health` remains variable-only inspection. Target schedule is effective; source/revision/binding permit edits only when all valid. INTERVAL_SKIPPED is skipped, notsuccess. ErrorSCHEDULE_INVALID carries safeerrorfield/code.

- [x] Add RED VMtests editor mode/count/time/window/mininterval, fixedtimeadd/delete, guardedpayload, reloadsavedvalues, resetconfirmation, revisionconflict, staleidentity, doubleclick, lateauthreply, draftrefresh and ambiguous503readback.

```js
assert.equal(page.target.schedule_source,'database');
assert.equal(call.options.credentials,'same-origin');
assert.equal(call.options.headers['X-CSRF-Token'],csrf);
assert.deepEqual(JSON.parse(call.options.body),{binding:target.target_binding,revision:target.schedule_revision,schedule:expected});
```

- [x] Add labeled details/formpercard, mode-specific fields, readonlyderivedcount, interval1..1440 and save/reset. NativeHTMLtimeinput with explicitservervalidation; no rawJSONeditor/Secrets/browserstorage.
- [x] Keep draftMap pertarget in page memory; preserve across normalrefresh/render, clear onlogout/reload/targetidentitychange. Draft revision remains edit-startrevision throughrefresh so stale drafts cannot overwrite new settings. Conflict retainsinput and prompts refresh/review, neverautosubmit. Provide explicitloadsaved/discard action if needed toresolveconflict.
- [x] Handle503unknownsave by reading actualtargets withoutresubmitting; preserve draft and clearly state uncertain/fullAlarmstatus. Successfulvalidatedresponse replaces targetstate and clears saved draft. Everyresponse observes sessiongeneration guard.
- [x] Extend safe target/schedule/error validators and display interval/source/checkpoint/skippedcause. Configsection says variableinitialvalues, card says effectiveDBvalues. Existing manual uncertainUUID logic unchanged.
- [x] Run fullUI/status suite, dummy desktop/mobile/keyboard QA with all business routes mocked; root scoped review.

### Task 4: Connected Verification and Concise Guides

**Files:** Root updates `cloudflare/README.md`, `README.md`, `docs/configuration.md`, specstatus and implementationcheckboxes; ignored localnative/browserQA only. Preserve untrackedreuseguide.

- [x] Run full `node --test cloudflare/test/*.test.mjs` and `.venv/Scripts/python.exe -m unittest discover -s tests`.
- [x] Add offline nativeMiniflare/Workerd test using installedconvertV4adapter/resourcePersistencePath, SQLite restart and object-formput atomic fault. Testcookieedit/read/reset/CSRF and blocked externalfetch; no live dispatch.
- [x] Run Wranglerdryrun(metricsfalse), actionlint, Python3.11grammar, Bashsyntax, MarkdownJSON/fences anddiffcheck. View dummydesktop/mobile screenshots.
- [x] Conciseguide: edit/restore/defaultinterval/automaticonly/variableprecedence/revisionconflict/unknownsave/savingnottriggering/crossday/dailycountvsactualattempt/rollback.
- [x] Generate full tracked+newfiles reviewpackage. Broad final independentreview, one boundedfixwave withREDregressions if needed; finalfullverification beforeclaimingcomplete.
- [x] Report actualevidence and all rulings; keep uncommitted/unpublished, no forcedcleanup.

**Local acceptance (2026-11-10):** 317 Cloudflare tests and 367 Python tests PASS; native Workerd/SQLite restart, Cookie/CSRF, revision conflict, reset and atomic rejection PASS with zero external requests. Mocked Chromium desktop/mobile/keyboard and dated prior-slot skip after reload PASS. Wrangler dry-run 146.82 KiB, actionlint, Python 3.11 grammar/compile, Bash syntax and 11 Markdown JSON blocks PASS. Final spec/quality review APPROVED; the only P2 (last-slot skip lost after rollover) was fixed with RED/GREEN regressions and re-reviewed. No implementation commit, push, deployment or business call. Automatic request spacing is not GitHub Actions start spacing; prior-slot display is not a full skip audit.

**Publication authorization (2026-11-10):** After local acceptance, the user requested commit/push to the established yidu456, nodeloc666 and emailtq repository main branches. This supersedes the implementation-only no-commit/no-push restriction for publication, not the ban on live business requests or manual deployment. Fresh regressions and remote-head verification are required before ordinary pushes; preserve unrelated local files and Git references.
