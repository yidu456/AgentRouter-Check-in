# Xray Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the proxy core with Xray and restore supported hosted macOS jobs.

**Architecture:** Preserve normalized node parsing and controller interfaces; render Xray at the runtime boundary. Reuse that runtime for legacy setup and credential-free platform smoke. Update macOS routing and report contracts together.

**Tech Stack:** Python 3.11, existing requests/Playwright, unittest, Xray, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-11-07-xray-backend-design.md

## Global Constraints

- Work on existing dev-plus; preserve user files and local ed/eh work.
- No supplied secrets, real proxy connections, account logins, bot sends or Checkin dispatch.
- Single Xray backend, SHA-256 checked platform ZIPs, no new package dependency.
- Preserve CHECKIN_CONFIG version 1 and final-only notifications.
- Standard hosted labels: ubuntu-24.04, windows-2022, macos-15.
- Root owns journals, README, legacy helper, smoke.py and integration; workers do not overlap those files.

### Task 1: Supported macOS Assignment

**Files:** routing.py, report.py, .github/workflows/Smoke.yml, tests/test_routing.py, tests/test_reports.py, tests/test_planning_cli.py, tests/test_workflow_contract.py.

**Interfaces:** Existing macos account value produces macos-15 manifest/matrix; report and assign validators require the new label.

- [x] Add regression asserting current label, retired-label rejection and unchanged Windows/Linux values; observe failures.
- [x] Update shared routing/report label contracts and live fixtures without rewriting historical records.
- [x] Run focused routing/report/planning/workflow tests; perform scoped review.

### Task 2: Xray Runtime

**Files:** proxy_runtime.py, tests/test_proxy_runtime.py.

**Interfaces:** parse_node_link returns existing normalized dictionary. build_proxy_config(outbounds) returns Xray JSON and candidate HTTP endpoints. download_binary returns xray/xray.exe. check_outbound and group_proxy retain signatures.

- [x] Verify pin/schema/checksums in schema-research.md; add adapter/download/lifecycle regression tests and observe failures.
- [x] Replace archive extraction with bounded root ZIP executable extraction and digest checks.
- [x] Render existing protocols, transport, TLS/Reality, Hy2/Salamander using pinned native schema; explicitly reject unsupported semantics.
- [x] Fail closed with blackhole default and catchall, isolated localhost inbounds and explicit rules.
- [x] Change schema command to xray run -test -c; preserve child cleanup, masked errors and candidate isolation.
- [x] Run focused tests and native dummy schema checks; perform scoped review.

### Task 3: Legacy and Platform Integration

**Files:** setup-proxy.sh, legacy_proxy.py, tests/test_legacy_proxy.py, tests/smoke.py, .gitignore, README.md.

**Interfaces:** legacy entrypoint reads NODE_LINK/PROXY_CONFIG_URL, starts shared Xray runtime and exports PROXY_SERVER through GITHUB_ENV.

- [x] Add mocked tests for no source, precedence, subscription decode, candidate failure cleanup, successful export and export-failure cleanup; observe failures.
- [x] Implement the smallest Python setup with shared parsing/download/config helpers and thin Bash wrapper; no global process killing.
- [x] Extend native dummy schema fixtures in smoke.py and retain localhost-only browser/proxy no-fallback test.
- [x] Document core pin, supported runner, ed/eh rules, subscription format limits and certificate policy; ignore generated Xray files.
- [x] Run full unittest, compile/3.11 grammar, Bash/actionlint/diff checks and native loopback smoke.

### Task 4: Review and Push

- [x] Review scoped tasks and connected whole change; address actionable findings and rerun checks.
- [ ] Stage only task-owned files, inspect staged diff and secret shapes; commit and push yidu456/dev-plus without force.
- [ ] Verify remote SHA; if possible run only credential-free Smoke and observe completion.
- [ ] Deliver evidence and remaining validation/credential risks in Chinese.
