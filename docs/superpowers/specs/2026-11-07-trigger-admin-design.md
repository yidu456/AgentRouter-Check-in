# Authenticated Trigger Administration

Approved by the user after the interactive preview on 2026-11-07. Implement the preview's behavior, not its sample data.

## Scope

Reuse the existing `SCHEDULES` SQLite-backed Durable Object per stable target ID. Do not create D1, new account dependencies or a separate mode variable. Keep `TRIGGER_CONFIG` target definitions and GitHub PAT/Webhook values in Cloudflare Variables/Secrets. Add only `DEBUG_ACCESS_TOKEN`, an optional independent high-entropy Secret of 32-128 URL-safe ASCII characters. Missing/empty/invalid access Secret closes all administration routes without stopping automatic schedules.

Keep unauthenticated `/` and `/health` locally computed, identity-free and effect-free. With a valid access Secret, `/` includes a same-origin external client bootstrap; `/#token=<access-token>` consumes and immediately removes the fragment, stores the token only in memory and authenticates requests with Bearer authorization. Reload requires reopening the original token link. Never accept query-string credentials, persist tokens in browser storage, or embed private target data in unauthenticated HTML/scripts. Use no-store, no-referrer, nosniff, frame denial and restrictive CSP. Compare SHA-256 token hashes using Workers timingSafeEqual (Node tests supply only that extension). Authenticated mutation requests are JSON POST, same-origin when Origin is present, bounded at 1024 bytes. No CORS allowance, GET mutations or incoming arbitrary upstream URLs.

## Storage And Scheduling

Current `plan` and alarms retain compatibility. Add binding-scoped `control` containing an explicit enabled override; absent override uses JSON enabled. Target changes reset override by ignoring its old binding. Cron must visit configured disabled targets too, because an explicit database enable may override JSON false. Selection rechecks persisted override at every dispatch. Close deletes the alarm and prevents further automatic/manual dispatch, but cannot cancel requests already sent to GitHub. Reopen preserves a future, unattempted matching plan; an elapsed plan is skipped and replanned under existing eligibleDate rules, without catch-up. GET reads do not initialize, redraw or repair schedules. Missing PAT shows no actionable next-run time.

Manual dispatch is independent of `plan`: no date, alarm or attempted-state changes. Client supplies a UUID `request_id`; store safe UNKNOWN before GitHub HTTP and retain receipt/result separately from visible history. Same receipt returns cached outcome without resending, including after visible history deletion. Retain receipts for 24 hours, at most 100 per target, reject new requests at capacity rather than evict valid receipts. Distinct manual requests have a 30-second cooldown. No automatic retry of GitHub/bot delivery; UI permits retry of an uncertain HTTP request only with its original request ID. Bot optional outcome uses the shared helper, with explicit automatic/manual source; accepted dispatch is not check-in success.

## History

Keep the latest 20 safe dispatch records per target, persisted before business HTTP and updated by stable UUID. Fields: `id`, `at` epoch milliseconds, `source` automatic/manual, `result` known dispatch code, `notification` known notification code. Automatic history creation is linked to persisted plan so a crash cannot cause another send. Redaction is by schema: no PAT, access token, Webhook, raw configuration, responses or exception text. Deletion is single-record or target history clear only. Preserve plan, alarm, control and idempotency receipts; never storage.deleteAll. Management deletion does not delete Cloudflare/GitHub platform logs.

## Interface

`GET /api/admin/targets` -> `{status, targets}` with authenticated repository/workflow/ref, effective enabled, safe token state, actual stored future `next_run` ISO UTC or null, history, and generic per-target state errors. No Secret names/values. `POST /api/admin/targets/:id/enabled` body `{enabled:boolean}`; `/run` body `{request_id:UUID}`; `/logs/delete` body `{log_id:UUID}`; `/logs/clear` body `{}`. Responses use safe known JSON codes; missing target 404, auth 401, disabled feature 404, bad body 400/413/415, cross-origin 403, disabled/no PAT/conflict 409, cooldown/capacity 429, unavailable storage 503.

UI matches approved blue/teal preview, target cards, switches, real stored next-run time in Asia/Shanghai, expandable history, modal run/delete confirmation, disabled actions for paused/missing-PAT targets, refresh, logout to public view. No mock claims or sample data ship. Public page describes JSON enabled counts as config defaults because it does not read persisted overrides. Manual result must explicitly distinguish GitHub accepted/rejected/unknown and bot status. No Actions polling or final-success inference.

## Verification And Delivery

Test first with Node built-in tests and mocked HTTP. Verify native workerd/SQLite persistence across restart, public privacy, authentication, override, manual dedupe after log deletion, unchanged automatic plan and bot outcome with dummy credentials/outbound interception. Verify desktop/mobile real UI using a local fixture and no business network. Update deployment/token/database guides. Run Node suite, Python suite/syntax, shell syntax, docs checks, diff checks and Wrangler dry-run. Review combined changes, commit task files only and fast-forward push `yidu456 HEAD:main`, checking remote SHA. Preserve existing AGENTS/planning and unrelated origin/local-main state. No real dispatch/login/bot send, manual Cloudflare deployment or old GitHub cron deletion.

## Entry Correction Approved 2026-11-08

Historical correction (superseded by the 2026-11-08 requirements below): `/` returns only hello world; the former fixed `/token` credential input and Bearer bootstrap were replaced. Retain Wrangler keep_names:false and test the actual Wrangler bundle, not just ES source.

## Approved Revision 2026-11-08

Use the actual DEBUG_ACCESS_TOKEN value as the hidden entry pathname. It is only a selector, not an authentication credential. ADMIN_USERNAME (runtime Text) and ADMIN_PASSWORD (runtime Secret) independently authenticate each private HTTPS Basic request, including Worker-to-DO requests; no Cookie, stored session or fragment bypass. No default credentials. Missing login configuration is explained at the configured entry; an invalid/missing selector still closes the entry. Root only greets, health remains private.

Three navigation sections separate repository operations/next time, safe configuration diagnostics/repair advice, and repository-grouped logs distinguishing workflow/ref/id. Delete one record or clear one target only; reuse existing SQLite logs and preserve receipts/schedules. Read failures are visible, never stale actionable state. New target omitted enabled defaults true; explicit false and matching stored disable remain intact. Existing daily scheduler and manual idempotency invariants are unchanged.

Verify dummy credentials, old Bearer rejection, native SQLite and actual bundled Chromium at five widths. Simplify deployment/token/current user guides. Combined delivery also adds backwards-compatible OS-grouped account configuration and independently verified login/balance reporting; no real business calls or manual deployment during verification.
