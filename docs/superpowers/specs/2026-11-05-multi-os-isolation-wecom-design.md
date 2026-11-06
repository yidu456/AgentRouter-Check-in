# Multi-OS Account Isolation and WeCom Design

Status: proposed design, ready for user review. Runtime implementation is not authorized by this document alone.

## 1. Goal and Boundaries

Run fixed groups of at most three accounts on GitHub-hosted Ubuntu, Windows, and macOS. Each account uses only its configured ordered proxy list and a fresh browser session. Add optional WeCom group robot webhook notifications alongside Telegram.

This is operational/session isolation, not an anti-association guarantee. Accounts in one group share an OS/runner environment. GitHub does not promise the same machine between runs. Different node names do not guarantee different exit IPs. Logging in and reading balance does not independently prove a daily reward was credited.

Excluded: random daily OS assignment, fingerprint-injection scripts, Canvas/WebGL spoofing, persistent browser profiles/cookies, replacement outside the account-owned configured list, enterprise application access-token messaging, and a UI/configuration service.

## 2. Existing Behavior and Compatibility

- app.py owns account parsing, browser login, balance formatting, Telegram, and per-account result handling.
- setup-proxy.sh is Linux-specific and selects one usable node for all accounts.
- The current workflow runs one Ubuntu job, including cleanup and keepalive.
- Preserve ACCOUNTS syntax: [site|]username:secret, including passwords containing colons.
- Preserve USERNAME/PASSWORD fallback, masking, existing login selectors, and bounded retries.
- When CHECKIN_CONFIG is absent, keep a single Ubuntu legacy job and current proxy fallback behavior. The standalone app.py entry point remains usable.
- When CHECKIN_CONFIG is present, require complete valid routing before any login. Free proxies and direct login are forbidden in this isolated mode.

## 3. One Complete Variable and 1..N Proxies per Account

CHECKIN_CONFIG is the only new user-facing variable, stored as a GitHub Secret. The complete configuration is JSON:

```json
{
  "version": 1,
  "subscription_url": "https://subscription.example.com/example",
  "notifications": {
    "telegram": {"bot_token": "example-token", "chat_id": "example-chat"},
    "wecom": {"webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"}
  },
  "accounts": [
    {
      "id": "a01",
      "site": "https://example.com",
      "username": "user1@example.com",
      "password": "example-secret:with-colon",
      "os": "ubuntu",
      "proxies": [{"node": "node-a"}, {"node": "node-b"}],
      "profile": {
        "viewport": {"width": 1440, "height": 900},
        "screen": {"width": 1440, "height": 900},
        "device_scale_factor": 1,
        "locale": "zh-CN",
        "timezone_id": "Asia/Shanghai",
        "color_scheme": "light"
      }
    },
    {
      "id": "a02",
      "username": "user2@example.com",
      "password": "example-secret-two",
      "os": "macos",
      "proxies": [{"link": "socks5://proxy.example.com:1080#dedicated-c"}]
    }
  ]
}
```

An account object owns its credentials, fixed OS, optional profile, and ordered 1..N proxy list. node references resolve against subscription_url in this same variable; direct links need no subscription. Notifications also live here; no separate new bot Secret is required.

Validation rules:

- Require integer version 1 (not bool), nonempty accounts, and only the four top-level fields shown. Reject unknown fields/malformed JSON with safe ROUTE_CONFIG_FAIL, never source excerpts.
- Required account fields: id, username, password, os, proxies. site defaults to https://agentrouter.org. IDs are unique opaque labels matching `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, not emails/node names.
- Normalize site scheme/host consistently and preserve path/username case. Reject duplicate normalized (site, username) records. Preserve nonempty JSON passwords exactly, including spaces, colons, bars, and Unicode. New mode does not split delimiter-based ACCOUNTS.
- os is ubuntu/windows/macos only; arbitrary runner labels are forbidden.
- proxies is nonempty and ordered. Each element contains exactly one nonempty node or link. node requires shared HTTPS subscription_url; link is a supported direct share link.
- Reject duplicate candidate references within or across accounts. Compare direct links without display fragments; distinct names may still share an actual exit IP.
- Subscription names come from decoded fragments or VMess ps. Duplicate names are invalid; missing/unnamed referenced nodes fail the candidate. Direct links need no display name because account ID/index determines binding.
- Profile keys are viewport, screen, device_scale_factor, locale, timezone_id, color_scheme only. Dimensions are integer 320..8192 (not bool), screen>=viewport, scale 1/2, locale zh-CN/en-US, timezone Asia/Shanghai/Asia/Tokyo/America/New_York/Europe/London, scheme light/dark.
- Defaults: viewport/screen 1440x900, scale 1, zh-CN, Asia/Shanghai, light. Explicit viewport without screen makes screen equal viewport. No Windows ZoneInfo dependency.
- notifications is optional and defaults to no channels. telegram needs both bot_token/chat_id; wecom needs valid webhook_url. Incomplete/unknown settings fail; absent JSON channels never inherit legacy bot values.
- Configuration size <=48 KiB UTF-8; reject >256 groups or candidates exceeding local port capacity instead of dropping data.
- Parse the complete new object before login. Invalid nonempty new configuration never merges/falls back to legacy account/proxy/bot variables.
- Direct Python execution distinguishes absent env from present empty env (error). GitHub cannot distinguish unset/empty Secret, so prepare treats empty as legacy and emits explicit mode. Nonempty malformed JSON always fails.

Proxy attempt rules: each scheduled login starts at list position 1. Try each configured candidate once, using the unchanged account profile and a fresh browser/context for the whole login/balance attempt. Failure closes the attempt before advancing to the next candidate of that account. First success stops; do not log in through remaining candidates. Never switch midway through a page/session, use another account's list, unlisted nodes, free proxies, or direct login. Exhaustion yields PROXY_LIST_EXHAUSTED and processing continues. List length and 30-minute worker deadline bound work; larger lists increase login-duration/rate-limit risk.

Group by fixed OS in ubuntu/windows/macos order, sort opaque IDs and chunk into groups of three. Reordering JSON/subscription entries does not alter account OS or proxy-list order. Emit only nonempty groups.

```json
{"version":1,"groups":[
  {"group_id":"g01","os":"ubuntu-24.04","account_ids":["a01"],"mode":"isolated"},
  {"group_id":"g02","os":"macos-14","account_ids":["a02"],"mode":"isolated"}
]}
```

Versioned runner labels reduce image-family drift but do not freeze hardware. Verify repository availability before activation.

## 4. Workflow and Secret Boundaries

```text
prepare (Ubuntu)
  parse/validate accounts and routes
  output sanitized matrix and manifest
        |
        +-- checkin g01 (Ubuntu): <=3 assigned accounts
        +-- checkin g02 (Windows): <=3 assigned accounts
        +-- checkin g03 (macOS): <=3 assigned accounts
        |
notify (Ubuntu, always)
  combine safe result artifacts, detect missing groups, send both channels
        |
maintenance (Ubuntu, always)
  cleanup old workflow records and keepalive once
```

- Matrix `fail-fast: false`; `max-parallel: 3`; each check-in job keeps the existing 30-minute timeout.
- Top-level concurrency prevents simultaneous scheduled/manual check-in runs. Set cancel-in-progress false so a new run does not kill an active account login.
- Never put credentials, sites, node names/links, subscription contents, or webhook URLs into matrix outputs/artifacts. Opaque IDs, OS labels, group IDs, and mode are the only public routing fields.
- New-mode prepare/checkin/notify receive the same CHECKIN_CONFIG Secret. Every recipient can read all account and bot credentials; this is execution isolation, not credential isolation. Workers suppress notification; only notify sends.
- GitHub Secrets are not per-account vaults: workers receiving CHECKIN_CONFIG can read all accounts and bot tokens. This design isolates execution, not mutually untrusted workers. Run only trusted default-branch code; no pull-request trigger with credentials.
- Use minimum permissions: contents read for prepare/checkin/notify; only maintenance has contents write and actions write.
- Cache browser binaries only; never cache session state, proxy configuration, reports with raw responses, or node subscriptions.
- Browser cache key includes runner.os, runner.arch, and Playwright version. Install system dependencies on Linux even after a browser cache hit; do not run apt/bash-specific setup on Windows/macOS.
- Push/commit side effects in maintenance are outside worker tasks. Preserve the existing once-per-run behavior; never replicate it in matrix jobs.

## 5. Native Candidate Proxy Runtime

Add proxy_runtime.py for isolated jobs. Keep setup-proxy.sh Linux-only for legacy mode with subscription/server/raw logs redacted. New mode never invokes Bash setup.

Fetch shared CHECKIN_CONFIG.subscription_url once per worker only when its account lists reference named nodes. Direct links come from each account.proxies element. Support plain/base64/base64url link subscriptions and vless, vmess, trojan, hysteria2/hy2, socks5/socks. Reject Clash YAML/arbitrary JSON subscriptions. Native configurations are dictionaries serialized with json, not shell-built strings.

Resolve candidates in list order; missing/malformed/unsupported candidates are skipped only within their owning account's list. Check each candidate's native configuration before including it so a bad candidate does not prevent valid candidates/accounts from starting.

One sing-box process per group creates a localhost HTTP inbound per valid candidate. Candidate tags use account ID/index, such as a01_p01/a01_p02. Ports start at 18080 and stay <=65535. There may be more than three proxy endpoints while account group size remains <=3.

```json
{
  "log":{"disabled":true},
  "inbounds":[{"type":"http","tag":"in-a01_p01","listen":"127.0.0.1","listen_port":18080}],
  "outbounds":[{"type":"socks","tag":"out-a01_p01","server":"proxy.example.com","server_port":1080,"version":"5"}],
  "route":{"rules":[{"inbound":["in-a01_p01"],"action":"route","outbound":"out-a01_p01"}]}
}
```

Every inbound maps to exactly one explicit outbound. No direct outbound, selector/urltest, or substitution. Transport probes and the browser use the current candidate endpoint; WAF/captcha responses are not clean-IP guarantees. Close a failed browser attempt before selecting the next configured candidate.

Use platform.system()/machine() for native Linux/Darwin/Windows amd64/arm64 assets. Pin version/digest as in the implementation plan. Validate SHA-256 before opening an archive; extract only its expected regular executable, never arbitrary paths/symlinks/extractall. Archive size limit 100 MiB.

Use subprocess argument lists, shell=False, and Windows CREATE_NO_WINDOW. Track Popen and terminate/wait/kill only that owned child, not broad pkill/fuser. Check/readiness timeout 15 seconds; shutdown wait 5 seconds; source/download HTTP timeout 30 seconds.

Runtime files live in a private TemporaryDirectory under RUNNER_TEMP, POSIX directory/config modes 0700/0600, stdout/stderr DEVNULL. Never upload configs, native logs, raw responses, or subscriptions.

## 6. Browser Configuration

Use real OS/browser defaults for User-Agent and client hints in isolated mode. Do not inject a macOS UA into Ubuntu/Windows. Pass the validated fixed profile to new_context and continue creating a fresh browser/context per configured-candidate attempt. Do not persist storage_state or user data directories.

Pinned proposed baseline, confirmed against public release metadata on 2026-11-05:

- Python 3.11.
- Playwright 1.64.1 (its metadata requires Python >=3.10).
- sing-box 1.14.4.
- Standard-library unittest and current requests/playwright/pynacl/pysocks dependencies; no bot SDK, YAML parser, or test framework.

Release metadata is not runtime validation. Three-system smoke tests must validate this baseline before activation. Maintain security updates rather than freezing vulnerable browser versions forever.

## 7. Safe Results and Missing Jobs

Each group writes one report before login with every assigned account marked UNFINISHED. Update it atomically after each result. Upload only that explicit JSON file in an always step; never upload a directory containing proxy files.

```json
{
  "version": 1,
  "group_id": "g01",
  "os": "ubuntu-24.04",
  "results": [
    {"id": "a01", "quota": 500000, "stage": "SUCCESS"}
  ]
}
```

Quota is a nonnegative integer or null, never bool/float/NaN. IDs/group/OS must match the prepare manifest. Reject unknown fields, duplicate IDs/reports, malformed JSON, and out-of-group IDs. Failure stages are from a fixed allowlist; never copy exceptions or page responses. A success needs a quota; a failure must have quota null.

Preserve existing browser stages: UNKNOWN, GOTO_TIMEOUT, WAF_TIMEOUT, FORM_NOT_FOUND, FORM_OPERATE_TIMEOUT, USER_API_FAIL, API_PAYLOAD_FAIL, QUOTA_INVALID, PAGE_TIMEOUT, BROWSER_LAUNCH_FAIL, UNEXPECTED, NO_PROXY, SUCCESS. Add PROXY_LIST_EXHAUSTED, UNFINISHED, ROUTE_CONFIG_FAIL, NODE_MISSING, NODE_CONFIG_FAIL, NODE_UNREACHABLE, PROXY_START_FAIL, JOB_MISSING, REPORT_INVALID, PREPARE_FAIL.

The notification job derives the isolated manifest from the fully validated complete configuration and reads only expected result filenames. This remains authoritative if the prepare artifact is missing, corrupt, or mismatched. Legacy mode reads the prepare manifest; an unusable legacy manifest produces one generic safe REPORT_INVALID final summary. A missing/crashed worker becomes JOB_MISSING for all its expected IDs. Invalid reports become REPORT_INVALID; neither is counted as success. prepare failure sends generic PREPARE_FAIL only when the complete configuration can still be validated and supplies trusted bot settings. Invalid JSON/channel configuration cannot reliably send a bot message; report it through safe GitHub job status/logs instead, never by merging old variables. Every expected account is accounted for even if a worker cannot upload a report.

Any failed/missing account makes the check-in outcome fail. Notification transport failure does not turn a successful login into a failed login and never prevents attempting the other channel. Explicit workflow cancellation cannot guarantee delivery of notifications.

## 8. WeCom and Telegram

Use optional CHECKIN_CONFIG.notifications.wecom.webhook_url and notifications.telegram.bot_token/chat_id, not another new bot Secret. Support the WeCom group robot webhook, not enterprise app access-token messages or intelligent-bot WebSocket sessions.

```json
{"msgtype": "text", "text": {"content": "Daily check-in\nUbuntu a01: balance $1.00\nSuccess 1/1"}}
```

- Require HTTPS, host qyapi.weixin.qq.com, path /cgi-bin/webhook/send, exactly one nonempty key; reject embedded credentials, fragments, and unexpected query fields. Do not print the URL/key.
- POST with requests, timeout 30 seconds, redirects disabled. Check successful HTTP status, a JSON object, and integer errcode == 0 (bool is not accepted as an integer result).
- No automatic retries on ambiguous network/API failure: the server may already have sent the message. Return false and print only a safe channel status.
- Text content is at most 2048 UTF-8 bytes. Split at line boundaries and, for an oversized line, at Unicode character boundaries. Preserve all account lines across chunks.
- Space WeCom sends by at least 3.1 seconds, respecting the documented maximum 20 messages/minute. Empty messages are not sent. No @all or rich-media feature in this scope.
- Preserve Telegram HTML output. Render WeCom separately as plain text; do not forward Telegram HTML to WeCom or strip it with a fragile replacement chain.
- Both JSON channels configured: send both independently without inheriting old bot variables. One configured: send that channel. Neither configured: finish check-in without notifications.
- Standalone/legacy runs still send their own summary. Matrix workers suppress notifications explicitly; the notify job sends the single run-level summary, chunked only when necessary.
- Generic fatal-script notifications also support both channels and contain only safe stage codes.

## 9. Files and Rollout

Modify app.py, setup-proxy.sh (legacy log redaction only), .github/workflows/Checkin.yml, and README.md. Add routing.py, proxy_runtime.py, report.py, .github/workflows/Smoke.yml, and focused tests/test_*.py files. Keep parsing/browser/notification helpers in app.py; do not refactor its unrelated login code.

Implement as reviewable increments:

1. Explicit bot transport/formatting helpers with mocked regression tests.
2. Complete single-variable parser and stable account groups.
3. Native proxy candidates, account-owned fallback lists, safe reports, matrix workflow, and docs.

Rollout: unit tests and syntax -> three-OS browser/proxy smoke tests without production credentials -> one permitted test account per OS with dedicated nodes -> full configured groups. Keep CHECKIN_CONFIG absent until the isolated path has passed validation. Removing it returns to the documented legacy behavior, including legacy fallback; make this configuration effect explicit.

README must correct the schedule to 06:45 Asia/Shanghai and document routes, node naming, unsupported subscription formats, Secret boundaries, quotas/costs, bot limits, and troubleshooting with safe stage codes.

## 10. Acceptance Criteria

- Eight routed accounts assigned 3 Ubuntu / 3 Windows / 2 macOS generate three jobs; ten accounts can generate another <=3-account job without duplication or omission.
- Reordering JSON account entries/subscription links does not change account-to-OS/node association.
- In isolated mode, assigned-node failure never invokes free-proxy discovery or direct browser login.
- A failed account/worker does not cancel other groups; aggregation reports missing outcomes correctly.
- Bots receive only labels, OS, balances, safe statuses, and totals; all credentials and raw responses stay out of logs/artifacts.
- Telegram-only, WeCom-only, both, neither, API rejection, timeout, and Unicode chunk boundaries are covered by mocked tests.
- All three platforms run the pinned browser and native sing-box binary, without Linux-only commands on Windows/macOS.
- Legacy absent-config behavior continues working; new JSON passwords and 1..N proxy order are preserved.
- Account lists attempt only configured candidates, stop on success, and use fresh sessions for fallback.
- Tests and actual smoke evidence, not this design alone, establish runtime support.

## Sources

- https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job
- https://developer.work.weixin.qq.com/document/path/91770
- https://pypi.org/pypi/playwright/json
- https://api.github.com/repos/SagerNet/sing-box/releases/tags/v1.14.4
