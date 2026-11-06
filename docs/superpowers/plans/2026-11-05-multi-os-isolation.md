# Multi-OS Account Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Runtime implementation requires user approval of the design and follows the WeCom increment.

**Goal:** Run each account once in a fixed <=3-account OS group through its assigned proxy, then send a single safe run-level summary.

**Architecture:** A pure routing module validates Secret configuration and produces a public matrix/manifest. Matrix workers use a native Python-managed sing-box process and existing Playwright login code, writing safe atomic reports. A final report job combines expected results and invokes the already implemented Telegram/WeCom dispatcher; maintenance runs once.

**Tech Stack:** Python 3.11, Playwright 1.64.1, sing-box 1.14.4, existing requests/pynacl/pysocks, unittest/mock, GitHub Actions matrix/artifacts.

**Spec:** docs/superpowers/specs/2026-11-05-multi-os-isolation-wecom-design.md.

## Global Constraints

- Implement docs/superpowers/plans/2026-11-05-wecom-notifications.md first; reuse its exact formatting/dispatch interfaces.
- Fixed runner families: ubuntu-24.04, windows-2022, macos-14; verify availability before enabling production routes.
- Group size 3, matrix max-parallel 3, fail-fast false, worker timeout 30 minutes, matrix maximum 256 groups.
- Isolated mode never invokes free-proxy discovery, global PROXY_SERVER fallback, or direct login.
- New mode reads only CHECKIN_CONFIG; legacy NODE_LINK/PROXY_CONFIG_URL behavior is preserved separately. Missing/invalid candidates may advance only within the account-owned configured list.
- No new runtime dependency, credential artifacts, persistent browser profile, or browser fingerprint spoofing.
- Runtime state stays in a private TemporaryDirectory under RUNNER_TEMP; only neutral result JSON is uploaded.
- Use Python subprocess argument lists; Windows helpers use CREATE_NO_WINDOW; terminate only owned processes.
- Preserve legacy account syntax, single-account fallback, per-account failure isolation, and failure exit codes.
- Account IDs, group IDs, OS labels, integer quotas, and allowlisted stages are the only report/routing output data.

## File Map

- Add routing.py: normalization, route/profile validation, grouping, sanitized prepare CLI.
- Add proxy_runtime.py: node indexing/parsing, verified binary download, per-account inbound configuration, owned process lifecycle.
- Add report.py: atomic safe report writing, schema validation, run-level aggregation/notify CLI.
- Modify app.py: JSON mode selection, selected group execution, explicit profile/proxy login, report updates, notification suppression.
- Modify setup-proxy.sh: redact legacy subscription/server/raw-log output; retain Linux-only legacy setup.
- Modify .github/workflows/Checkin.yml: prepare/matrix/notify/maintenance, pins, platform-dependent installs and caches.
- Add .github/workflows/Smoke.yml: manual credential-free three-OS browser/proxy tests.
- Modify README.md: account routes, naming, OS/proxy/notification constraints, actual 06:45 schedule, staged activation.
- Add tests/test_routing.py, tests/test_proxy_runtime.py, tests/test_isolated_checkin.py, tests/test_reports.py, tests/test_workflow_contract.py.

### Task 1: Complete JSON Parsing and Stable Groups

**Interfaces:**
- `routing.parse_config(raw: str) -> dict`: validate complete CHECKIN_CONFIG, returning normalized accounts/subscription_url/notifications. Errors contain only ROUTE_CONFIG_FAIL.
- `routing.normalize_site(value: str) -> str`: default site, normalized scheme/host, preserved path and username case.
- `routing.build_manifest(accounts: list[dict]) -> dict`: public IDs/groups/OS/mode only.
- CLI `python routing.py prepare --manifest PATH`: parse the single Secret in new mode; empty GitHub Secret emits one legacy Ubuntu group using app.parse_accounts. Never merge JSON fields with old variables.
- Legacy parse_accounts remains delimiter-based and unchanged; new account objects come only from parse_config.

- [x] **Step 1: Add failing parser/grouping tests.**

```python
import json
import unittest
import routing

class ConfigTests(unittest.TestCase):
    def test_secret_and_proxy_order_preserved(self):
        raw = {"version":1,"accounts":[{
            "id":"a01","username":"unit-user","password":" a:b|c ","os":"ubuntu",
            "proxies":[{"link":"socks5://one.example:1080"},{"link":"socks5://two.example:1080"}]
        }]}
        parsed = routing.parse_config(json.dumps(raw))
        account = parsed["accounts"][0]
        self.assertEqual(account["password"], " a:b|c ")
        self.assertEqual(account["proxies"], raw["accounts"][0]["proxies"])
        self.assertEqual(account["site"], "https://agentrouter.org")
        self.assertEqual(parsed["notifications"], {})
```

Cover invalid/blank/oversized JSON, version bool/non-1, unknown fields, empty accounts/proxies, missing required fields, node+link/node without subscription, duplicates within/across lists, invalid bots/profile fields, disabled JSON channels with old env set, and no legacy credential fallback. Add 3/3/2, ten-account, 256-group/port-capacity, and reorder-stability tests; verify public output excludes secret/site/node/link/bot data. Keep legacy parser tests for colons/malformed lines/USERNAME+PASSWORD.

- [x] **Step 2: Run tests and confirm missing APIs fail.**

```bash
python -m unittest discover -s tests -p test_routing.py -v
```

- [x] **Step 3: Implement all-or-nothing schema validation exactly as spec section 3.**

```python
if not raw.strip() or len(raw.encode("utf-8")) > 48 * 1024:
    raise ValueError("ROUTE_CONFIG_FAIL")
value = json.loads(raw)
if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
    raise ValueError("ROUTE_CONFIG_FAIL")
if set(value) - {"version","subscription_url","notifications","accounts"}:
    raise ValueError("ROUTE_CONFIG_FAIL")
```

Complete required-field/type/duplicate/profile/proxy-list/channel checks before returning normalized records. Preserve JSON passwords/list order exactly; no eval, delimiter split, random OS, old env merge, YAML dependency, or Windows ZoneInfo dependency. Subscription and bot validation never sends login/messages.

- [x] **Step 4: Implement grouping with explicit public projection and prepare output.**

```python
RUNNERS = {"ubuntu":"ubuntu-24.04","windows":"windows-2022","macos":"macos-14"}
def build_manifest(accounts):
    groups = []
    for name, runner in RUNNERS.items():
        chosen = sorted((a for a in accounts if a["os"] == name), key=lambda a:a["id"])
        for offset in range(0, len(chosen), 3):
            groups.append({"group_id":f"g{len(groups)+1:02}","os":runner,
                "account_ids":[a["id"] for a in chosen[offset:offset+3]],"mode":"isolated"})
    if len(groups) > 256:
        raise ValueError("ROUTE_CONFIG_FAIL")
    return {"version":1,"groups":groups}
```

Write compact matrix {include:groups} to GITHUB_OUTPUT and the public manifest, never stdout parsed configuration. A missing/empty GitHub Secret selects explicit legacy mode; nonempty malformed JSON exits 1 with safe code. For legacy CLI locally import app after routing definitions to avoid circular imports. Direct Python invocation treats present empty CHECKIN_CONFIG as an error.

- [x] **Step 5: Run parser tests, inspect a dummy public manifest, then commit task-owned files only if authorized.**

```bash
python -m unittest discover -s tests -p test_routing.py -v
git add routing.py tests/test_routing.py
git commit -m "feat: parse complete account and proxy-list configuration"
```

### Task 2: Node Parsing and Native Binary Verification

**Interfaces:**
- `load_node_links(subscription_url: str) -> dict[str, str]`: one shared subscription fetch per worker when needed; direct links come from account.proxies.
- `parse_node_link(link: str, tag: str) -> dict`: validated sing-box outbound; safe NODE_CONFIG_FAIL on invalid assigned input.
- `download_binary(system: str, machine: str, directory: Path) -> Path`: verified native executable under the supplied private directory.
- New nodes/protocols not in the spec are rejected, not passed through to shell commands.

- [x] **Step 1: Write failing node/binary tests.** Check plaintext and padded/unpadded base64url subscriptions, CRLF, duplicate/missing names, percent-encoded fragments/auth fields, IPv6/port parsing, invalid port/bool fields, unsupported transports, YAML rejection, direct-link/no-subscription behavior, and timeout without sensitive logging. Cover all five node families and both aliases.

```python
def test_named_socks_node(self):
    outbound = proxy_runtime.parse_node_link(
        "socks5://unit-user:unit-secret@proxy.example.com:1080#node-a", "out-a01"
    )
    self.assertEqual(outbound["type"], "socks")
    self.assertEqual(outbound["server"], "proxy.example.com")
    self.assertEqual(outbound["server_port"], 1080)
    self.assertEqual(outbound["tag"], "out-a01")
    self.assertEqual(outbound["version"], "5")
```

For downloads mock requests and in-memory archives. Test every platform mapping, wrong digest, missing executable, path traversal, links in tar/zip, unexpected architecture, and network failures. Never extract a full archive to test the production path.

- [x] **Step 2: Run tests and confirm failure.**

```bash
python -m unittest discover -s tests -p test_proxy_runtime.py -v
```

- [x] **Step 3: Implement source decoding and conversion using urllib.parse/base64/json.** Decode fragments with unquote for stable names; when a VMess link has no fragment use its nonempty ps field. Reject duplicate names before account selection. Referenced subscription nodes require names; direct candidates need no display name. Strip empty/comment lines; plaintext must contain recognized node-link schemes, otherwise decode base64url with correct padding and validate the decoded lines. Never interpret Clash YAML/JSON as links.

Common URL conversions use urlsplit hostname/port and unquote username/password. vmess instead base64-decodes a JSON object, extracting add/port/id/ps/net/tls/sni/host/path. Construct native fields with this table:

| Family | Required fields | Optional validated fields |
| --- | --- | --- |
| vless | type=vless, server, server_port, uuid, tag | flow; TLS/reality; WS or gRPC transport |
| vmess | type=vmess, server, server_port, uuid, security=auto, tag | TLS; WS or gRPC transport |
| trojan | type=trojan, server, server_port, password, tag | TLS enabled; WS or gRPC transport |
| hysteria2/hy2 | type=hysteria2, server, server_port, password, tag | TLS enabled, SNI, explicit insecure flag; salamander obfs password |
| socks5/socks | type=socks, server, server_port, version=5, tag | decoded username/password |

TCP means omit transport; never generate `{"type":"tcp"}`. WS means type=ws, path, optional headers.Host. gRPC means type=grpc and service_name from serviceName. Reject other transports. TLS server_name comes from sni or server; insecure defaults false. vless reality requires public_key and valid short_id, with explicit reality enabled. Reject unrepresentable mandatory parameters rather than silently degrading security.

- [x] **Step 4: Pin and verify native assets.** Map platform.machine aliases x86_64/amd64 -> amd64, aarch64/arm64 -> arm64; accept only assets below. SHA-256 metadata was retrieved from the v1.14.4 GitHub release API; validate downloaded bytes against these constants before opening the archive.

| Asset | SHA-256 |
| --- | --- |
| sing-box-1.14.4-linux-amd64.tar.gz | 699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968 |
| sing-box-1.14.4-linux-arm64.tar.gz | 436441f76ee2f7fe21b5b2d426d3cb261a480455a704865789ad533e4273ec26 |
| sing-box-1.14.4-darwin-amd64.tar.gz | eae86b9b033bba50b7c44ab719e4bfac0aca05efd28483390ed3aa510f32db25 |
| sing-box-1.14.4-darwin-arm64.tar.gz | 0d8c7f5ed5d587b0f1a5e9772a708ec3bfa4ac4c9329604b01d8d9c2ba406838 |
| sing-box-1.14.4-windows-amd64.zip | 99185d75d314a07dbba4a130c8ad986cbeb629a07927975636b341ca61f991df |

Download URL prefix: https://github.com/SagerNet/sing-box/releases/download/v1.14.4/. Maximum archive size 100 MiB, read as a bounded streamed response, timeout 30 seconds. Validate the selected archive member is a regular file under the expected release directory with basename sing-box or sing-box.exe; read only that member's bytes into a fixed destination path. No extractall, archive-provided destination, or symlink target. chmod the POSIX executable to 0700.

- [x] **Step 5: Run parsing/download tests and inspect safe failure paths.** Commit this task if authorized:

```bash
python -m unittest discover -s tests -p test_proxy_runtime.py -v
git add proxy_runtime.py tests/test_proxy_runtime.py
git commit -m "feat: parse named nodes and verify native sing-box assets"
```

### Task 3: Explicit Proxy Routes and Owned Process Lifecycle

**Interfaces:**
- `build_proxy_config(outbounds: dict[str, dict]) -> tuple[dict, dict[str, str]]`: returns native config and opaque candidate tag -> localhost HTTP endpoint.
- `group_proxy(outbounds: dict[str, dict], binary: Path, directory: Path)`: context manager yielding endpoints; failures raise safe PROXY_START_FAIL.
- Tags are account ID plus original list index (a01_p01). Preserve candidate order separately. Check each candidate with sing-box check before including valid outbounds, so one bad candidate does not break other accounts.

- [x] **Step 1: Write failing config/lifecycle tests.** Assert one account with three candidates and two accounts with one each create five distinct 127.0.0.1 ports/inbound tags/outbound tags and exact matching rules. Assert no direct/selector/urltest outbound, no endpoint supplied for a failed node, and no unrelated process termination. Mock Popen/socket/time; test check failure, readiness timeout, child exits early, normal exit, unexpected browser exception, terminate timeout followed by kill, and Windows creationflags.

- [x] **Step 2: Run test_proxy_runtime.py and confirm the new failures.**

- [x] **Step 3: Implement exact tag/port routing.**

```python
config = {"log": {"disabled": True}, "inbounds": [], "outbounds": [], "route": {"rules": []}}
endpoints = {}
for offset, account_id in enumerate(sorted(outbounds)):
    port = 18080 + offset
    inbound_tag, outbound_tag = f"in-{account_id}", f"out-{account_id}"
    outbound = dict(outbounds[account_id], tag=outbound_tag)
    config["inbounds"].append({
        "type": "http", "tag": inbound_tag,
        "listen": "127.0.0.1", "listen_port": port,
    })
    config["outbounds"].append(outbound)
    config["route"]["rules"].append({
        "inbound": [inbound_tag], "action": "route", "outbound": outbound_tag,
    })
    endpoints[account_id] = f"http://127.0.0.1:{port}"
```

Reject zero outbounds or candidate count exceeding local port range. Account count <=3 does not limit candidate count to three. Save config with json.dump inside the private runtime directory, with 0600 on POSIX. `sing-box check -c CONFIG` must succeed before `sing-box run -c CONFIG`; check timeout 15 seconds. Redirect stdout/stderr to DEVNULL, not public files. Start Popen with shell=False and Windows CREATE_NO_WINDOW. Poll owned child plus all local ports for at most 15 seconds. In finally terminate/wait(5), then kill/wait only that Popen if necessary. Do not use broad pkill/fuser or enumerate unrelated processes.

- [ ] **Step 4: Re-run tests and run sing-box check on generated dummy configs in each OS smoke job before auth tests.** Commit task-owned files if authorized:

```bash
python -m unittest discover -s tests -p test_proxy_runtime.py -v
git add proxy_runtime.py tests/test_proxy_runtime.py
git commit -m "feat: isolate account proxy routes with owned native processes"
```

### Task 4: Safe Report Contract and Run-Level Aggregation

**Interfaces:**
- `report.write_report(path: Path, manifest_group: dict, rows: list[dict]) -> None`: project only version/group_id/os/results; validate and atomically replace via a sibling temporary file.
- `report.combine_reports(manifest: dict, reports_dir: Path) -> list[tuple[str, str | None, str]]`: ordered rows for format_notifications, labels are `OS a01`; map missing/invalid reports to safe stages.
- CLI `python report.py notify --manifest PATH --reports-dir PATH`: inspect PREPARE_RESULT, read safe files, call app.format_notifications/send_notifications; exit 1 for any missing/failed outcome, independent of channel failure.

- [x] **Step 1: Add failing report tests.** Test valid quotas, bool/float/NaN rejection, success-with-null/failure-with-quota rejection, unknown fields/stages, duplicate IDs/files, wrong OS/group, out-of-group IDs, missing report, corrupt JSON, and atomic old-file preservation when a write fails. Source reports contain a deliberate unknown secret field; assert it cannot enter output. Mock bot calls in aggregation tests.

```python
import tempfile
import unittest
from pathlib import Path
import report

class ReportTests(unittest.TestCase):
    def test_missing_group_is_not_silently_successful(self):
        manifest = {"version": 1, "groups": [{
            "group_id": "g01", "os": "ubuntu-24.04",
            "account_ids": ["a01", "a02"], "mode": "isolated",
        }]}
        with tempfile.TemporaryDirectory() as directory:
            rows = report.combine_reports(manifest, Path(directory))
        self.assertEqual([row[2] for row in rows], ["JOB_MISSING", "JOB_MISSING"])
        self.assertTrue(all(row[1] is None for row in rows))
```

- [x] **Step 2: Run tests and observe missing report interfaces.**

```bash
python -m unittest discover -s tests -p test_reports.py -v
```

- [x] **Step 3: Implement fixed-schema validation and atomic writes.** Stage allowlist is exactly the spec list, including PROXY_LIST_EXHAUSTED; never normalize arbitrary exception strings into stages. Quota validation uses type(quota) is int and quota >= 0. Require exact schema keys/expected IDs and single results file per expected group. The public manifest itself must have only the spec keys, valid IDs/runner names, unique groups/account IDs, and <=3 IDs per group. Expected artifact path is `checkin-results-GROUP_ID/result.json`; never glob-upload/read raw runtime files.

```python
temporary = path.with_name(path.name + ".tmp")
with temporary.open("w", encoding="utf-8") as stream:
    json.dump(public_report, stream, ensure_ascii=True, allow_nan=False)
os.replace(temporary, path)
```

Map a missing file to JOB_MISSING, invalid content to REPORT_INVALID, both with quota null. PREPARE_RESULT != success sends only generic PREPARE_FAIL when complete new config is valid and supplies trusted channel settings, then exits 1. Invalid JSON/channel settings produce only a safe GitHub failure status; do not extract partial bot fields or merge legacy settings. Missing artifacts must not prevent a valid generic path. Format quota using app.format_balance, call format_notifications(rows, success_count, total), then send_notifications with the explicit parsed notifications subobject in new mode, config=None in legacy mode. Do not import app at report module top level; use local imports to avoid app/report circular imports and browser side effects.

- [x] **Step 4: Run report tests and notification regressions.** Commit if authorized:

```bash
python -m unittest discover -s tests -v
git add report.py tests/test_reports.py
git commit -m "feat: aggregate validated account reports and missing jobs"
```

### Task 5: Isolated Login Path Without Legacy Fallback

**Interfaces:**
- Extend `browser_login_complete(account: dict, proxy: dict | None = None, profile: dict | None = None, isolated: bool = False) -> tuple`.
- Add `checkin_assigned_account(account: dict, candidates: list[dict], profile: dict) -> tuple`; attempt each account-owned candidate once in order, stop after first success; exhaustion returns PROXY_LIST_EXHAUSTED. No free/direct/unlisted fallback.
- Add `run_isolated_group(routes: list[dict], manifest_group: dict, result_path: Path) -> int`; records all assigned outcomes and returns 0/1.
- Entry env: CHECKIN_MODE=isolated/legacy, GROUP_ID, ACCOUNT_IDS as JSON IDs, RUNNER_KEY as an allowlisted runner label, RESULT_PATH as a local file. Direct app.py without matrix env keeps its existing standalone path.

- [x] **Step 1: Add failing browser/orchestration tests.** Verify argument forwarding to launch/new_context, true native UA defaults in isolated mode, fixed validated profile, missing proxy refusal, ordered candidate attempts, unchanged profile, fresh browser/context per candidate, and stopping remaining candidates after success. Patch fetch_proxy_pool/pop_proxy and assert neither is called in isolated mode. Patch the browser helper and assert it is never called with proxy=None. A first-account failure still attempts the next; report skeleton precedes binary/network work; browser and proxy close on unexpected failures; workers never call bots.

```python
def test_account_list_stops_on_first_success(self):
    candidates = [{"server":"http://127.0.0.1:18080"},
                  {"server":"http://127.0.0.1:18081"},
                  {"server":"http://127.0.0.1:18082"}]
    with patch.object(app, "pop_proxy") as pool, \
         patch.object(app, "browser_login_complete", side_effect=[
             (None,"WAF_TIMEOUT"), ({"quota":500000},"SUCCESS")
         ]) as login:
        result = app.checkin_assigned_account({"id":"a01"}, candidates, {"locale":"zh-CN"})
    pool.assert_not_called()
    self.assertEqual(login.call_count, 2)
    self.assertEqual(result[1], "SUCCESS")
    self.assertEqual([call.kwargs["proxy"] for call in login.call_args_list], candidates[:2])
```

- [x] **Step 2: Run isolated tests and confirm failure before adding orchestration.**

```bash
python -m unittest discover -s tests -p test_isolated_checkin.py -v
```

- [x] **Step 3: Implement strict endpoint selection and native profile forwarding.**

```python
if isolated and not (proxy and proxy.get("server")):
    return None, "NODE_UNREACHABLE"

context_options = dict(profile or {}) if isolated else {
    "viewport": {"width": 1920, "height": 1080}, "user_agent": USER_AGENT,
}
context = browser.new_context(**context_options)
```

The isolated guard must run before the existing `elif PROXY_SERVER` branch. Keep legacy browser arguments/headers unless an OS smoke test proves a specific change is required; never add fingerprint injection. Transport-probe requests use the assigned endpoint explicitly and do not inherit global BROWSER_HEADERS claiming Windows. Transport failures record NODE_UNREACHABLE; WAF responses proceed to the existing browser stage handling.

Inside run_isolated_group: parse CHECKIN_CONFIG, reconstruct its assigned public group from config["accounts"], verify GROUP_ID/ACCOUNT_IDS/RUNNER_KEY exactly, and create UNFINISHED rows before fetching nodes. Resolve account.proxies in original order, taking each node from the shared subscription or its direct link. Skip missing/invalid candidates only within the owning list. Use original candidate-index tags for local endpoints. Start one proxy instance for valid nodes; group startup failure marks those accounts PROXY_START_FAIL. For each runnable account call checkin_assigned_account with its ordered valid endpoint list and unchanged profile, one fresh attempt per candidate, stopping after success, save a safe result atomically, and continue. Only safe stage constants enter reports. No raw credentials may enter report rows.

Use old run_checkin only when CHECKIN_CONFIG is absent or prepared mode is legacy. New mode reads only parsed JSON accounts/notifications, ignoring old credential/proxy/bot variables. Standalone new mode requires all configured account OS values to match the actual host; otherwise fail safely instead of spoofing an OS. In a legacy matrix worker, suppress its notifications and serialize its masked outcomes using manifest legacy IDs; execute legacy Bash setup only on Ubuntu before app.py. Preserve standalone notifications and exit codes. Always persist group results before returning/raising SystemExit, and add a finalizer for unhandled worker exceptions that leaves unresolved rows UNFINISHED.

Implement checkin_assigned_account with the explicit ordered list; no other proxy source is consulted:

```python
for candidate in candidates:
    result, stage = browser_login_complete(account, proxy=candidate, profile=profile, isolated=True)
    if result:
        return result, stage
return None, "PROXY_LIST_EXHAUSTED"
```

Candidate health checks may skip unreachable entries before this loop, without direct probing of the target. Browser attempts preserve profile and create fresh sessions. Add tests for first success, third success, all failed, malformed/absent candidates, no list sharing, and exceptions closing the browser before next attempt.

- [x] **Step 4: Run all unit tests, Python syntax checks, and verify no unrequested login logic changes.** Commit if authorized:

```bash
python -m py_compile app.py routing.py proxy_runtime.py report.py
python -m unittest discover -s tests -v
git add app.py tests/test_isolated_checkin.py
git commit -m "feat: run assigned accounts without proxy fallback"
```

### Task 6: Four-Job Workflow, Permissions, and Compatibility Documentation

**Interfaces:** Consumes routing prepare CLI, matrix worker env, report notify CLI, and both-channel Secret support. Produces a complete workflow plus a credential-free manual smoke workflow.

- [x] **Step 1: Add tests/test_workflow_contract.py checking key safety invariants without a YAML dependency.** Start with this source-text guard, then add exact runner mappings, single-Secret scope and worker bot suppression, unique maintenance job, explicit artifact file paths, and pinned versions. Source assertions are a lightweight guard, not a substitute for GitHub's workflow parser.

```python
import unittest
from pathlib import Path

class WorkflowTests(unittest.TestCase):
    def test_group_failure_does_not_cancel_other_groups(self):
        source = Path(".github/workflows/Checkin.yml").read_text(encoding="utf-8")
        self.assertIn("fail-fast: false", source)
        self.assertIn("max-parallel: 3", source)
        self.assertIn("cancel-in-progress: false", source)
        self.assertNotIn("pull_request_target:", source)
```

- [x] **Step 2: Run the contract tests before changing the workflow.**

```bash
python -m unittest discover -s tests -p test_workflow_contract.py -v
```

- [x] **Step 3: Replace the single-job workflow with the spec graph.** Keep the name, schedule `45 22 * * *`, and workflow_dispatch. The core worker must use:

```yaml
concurrency:
  group: daily-checkin
  cancel-in-progress: false

jobs:
  checkin:
    needs: prepare
    if: needs.prepare.result == 'success'
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    permissions:
      contents: read
    strategy:
      fail-fast: false
      max-parallel: 3
      matrix: ${{ fromJSON(needs.prepare.outputs.matrix) }}
```

prepare runs `python routing.py prepare --manifest manifest.json` and uploads only manifest.json as checkin-manifest. Install Python 3.11 and Playwright 1.64.1 consistently in jobs importing app.py. Use browser cache key `${runner.os}-${runner.arch}-playwright-1.64.1`; Linux always installs system dependencies, even with browser cache hit. Workers without a cached binary run `python -m playwright install chromium`; the Linux system-dependency step is separately conditional on runner.os == Linux.

New-mode prepare/checkin/notify receive CHECKIN_CONFIG plus public assignment/control env. Every recipient can read all included account/bot credentials: execution isolation is not credential isolation. Never place credential-derived values in prepare outputs. Set CHECKIN_MODE/GROUP_ID/ACCOUNT_IDS/RUNNER_KEY/RESULT_PATH, run app.py, and upload exactly RESULT_PATH with `if: always()`, artifact name checkin-results-GROUP_ID, and retention 1 day. Do not upload RUNNER_TEMP or sing-box logs/configs. The legacy Bash step runs only for mode legacy on Linux; isolated workers never invoke it. Redact existing Bash lines echoing subscription URL, outbound server, raw node data, or cat sing-box.log; replace them with fixed safe statuses and preserve control flow.

notify needs prepare/checkin and uses `if: always()`. Download the manifest only when prepare succeeded, and download result artifacts with pattern checkin-results-* without merging group directories. Missing download results must not skip report.py; it synthesizes missing outcomes. notify parses CHECKIN_CONFIG.notifications (no legacy merge in new mode) and sets PREPARE_RESULT before calling report.py notify. Worker failure and notify outcome remain visible even when maintenance succeeds.

maintenance needs prepare/checkin/notify, uses `if: always()`, runs on Ubuntu, and owns actions write/contents write. Move current cleanup/keepalive here once, leaving workers read-only. Preserve nonproduction changes already in the user worktree; do not execute maintenance commands locally to test the workflow.

- [x] **Step 4: Add .github/workflows/Smoke.yml as a manual, no-Secrets matrix test.** Run Ubuntu/Windows/macOS unit tests, native sing-box download/check, and local HTTP/SOCKS forwarding against a temporary local upstream. Launch Chromium against a local fixture, check reported browser/platform/profile values, and verify that disconnecting the assigned upstream fails rather than making a direct fixture request. Use dummy credentials only. This tests configuration/process compatibility, not third-party site acceptance.

- [x] **Step 5: Update README with the spec's full configuration example and exact limits.** Document the complete CHECKIN_CONFIG example, exact JSON credential handling, ordered 1..N proxies, node/direct-link forms, opaque IDs, <=3-account groups, fixed OS/profiles, and CHECKIN_CONFIG absent/present behavior, unsupported subscription formats, one run-level dual-channel summary, temporary reports, cross-OS costs/concurrency, and actual 06:45 schedule. Never include actual account/node/webhook values.

- [ ] **Step 6: Run offline checks and GitHub's credential-free smoke matrix.**

```bash
python -m py_compile app.py routing.py proxy_runtime.py report.py
python -m unittest discover -s tests -v
bash -n setup-proxy.sh
git diff --check
```

After all three smoke jobs pass, review the connected code and workflow for secret handling, fallback, report recovery, and permission regressions. Commit only implementation/test/docs files if authorized:

```bash
git add .github/workflows/Checkin.yml .github/workflows/Smoke.yml setup-proxy.sh README.md tests/test_workflow_contract.py
git commit -m "feat: schedule fixed multi-OS account groups and one summary"
```

## Activation Checkpoint

- [x] Confirm the design with the user before runtime implementation.
- [x] Complete and review explicit notification helpers first, then the complete JSON parser before orchestration.
- [ ] Complete all offline tests and all three credential-free smoke jobs.
- [ ] Obtain user approval for real test logins and a real bot delivery test; use one permitted test account/node per OS and a test group.
- [ ] Enable full CHECKIN_CONFIG only after observing the expected assignments, safe reports, and no fallback behavior.
- [x] Report actual validation evidence and remaining platform/site limitations. Push or create a PR only when requested; attach any created PR to the task.

No implementation test result is implied by checking the design documents themselves.

## Implementation Evidence (2026-11-06)

Implemented on dev-plus; no commits, pushes, production logins or bot sends. Fresh full standard-library suite: 109 tests pass on local Python 3.12; all runtime modules compile and parse under the Python 3.11 grammar. Git Bash syntax, actionlint 1.7.12 workflow schema/expressions, and git diff --check pass. Actionlint shellcheck/pyflakes integrations were unavailable and disabled.

Routing, proxy, report and integration reviews have no outstanding actionable findings. Mutation checks detect canonical proxy identity, duplicate names/format guards, first-success stopping, worker OS/assignment checks, and configuration-authoritative aggregation regressions.

Windows native verification passes: SHA-verified sing-box 1.14.4 accepts six dummy schemas including Reality gRPC; actual Chromium exposes configured nondefault locale/timezone/viewport/screen/scale/color values and native OS/UA; localhost proxy login succeeds and disconnecting all accepted fixture tunnels prevents direct fallback. Native checks use dummy credentials and loopback targets only.

New aggregation uses the fully validated CHECKIN_CONFIG to reconstruct expected groups rather than trust downloaded manifest contents. This accounts for missing/corrupt/mismatched manifests without losing the final summary. Legacy mode with an unusable manifest sends one safe generic REPORT_INVALID final result.

The two unchecked execution steps require actual Ubuntu/macOS GitHub smoke jobs. The workflow exists but has not been uploaded/run. Real login/bot delivery, actual Actions artifact handoff, and Python 3.11 runtime remain untested. Default-branch integration is required before scheduled activation. A shared Secret is not credential isolation; fixed basic profiles and explicit proxies do not guarantee accounts cannot be associated.
