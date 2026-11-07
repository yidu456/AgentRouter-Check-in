# Xray Backend and Supported macOS Runner

## Approved Scope

The user approved replacing sing-box with Xray on dev-plus, and fixing the
unsupported macos-14 runner. Keep CHECKIN_CONFIG version 1, account-owned
ordered proxy lists, per-candidate loopback ports, real-OS Chromium profiles,
bounded retries, safe reports, and final-only Telegram/WeCom aggregation.
There is no dual-core switch, browser spoofing feature, or real-login test.

## Runtime

Keep the existing validated node dictionary as an internal representation.
Render Xray JSON only at build_proxy_config. Retain the public download,
schema-check and context-managed group_proxy interfaces used by app.py.
Use official Xray 26.1.23 ZIPs with SHA-256 for each supported platform.
This compatibility release preserves explicit allowInsecure; later releases
reject it at the current date. Default certificate checking stays enabled.
Document that the old release lacks subsequent fixes, force native subprocess
GODEBUG multipathtcp=0, and do not expose CA certificate pinning affected by
the later Hy2/gRPC advisory. Never silently weaken or change certificate policy.

Support existing VLESS, VMess, Trojan, SOCKS5 and Hysteria2 link subsets only
where verified against the pinned core. Translate WS early data to Xray's
path ed query and fixed Sec-WebSocket-Protocol header; reject incompatible
custom headers, conflicting ed values, and unsupported Reality transports.
Keep full UUID validation and all existing trust-boundary checks.

Use localhost HTTP inbounds, explicit inbound-to-outbound routing, a first
blackhole outbound and final catchall blackhole rule. Never emit freedom or
unlisted proxy fallback in isolated mode. Run native schema tests before
starting the owned child, suppress native credential-bearing output, and
terminate/kill only that child on failure and context exit.

## Legacy Path

Replace the large sing-box Bash implementation with a thin Bash entrypoint
and Python setup using shared runtime helpers. Keep NODE_LINK and
PROXY_CONFIG_URL precedence, first usable node selection, PROXY_SERVER
export and existing application-level legacy fallback semantics. Only the
selected owned Xray process survives the setup step. Candidate failures
close their child; setup/export failure also closes the selected child.
No global pkill or occupied-port process killing is allowed.

## Hosted Systems

Map macos to standard macos-15 (ARM64), replacing the retired macos-14 label
in routing, report validation, live tests and Smoke.yml. Keep ubuntu-24.04
and windows-2022. Account OS strings and browser profile APIs are unchanged.

## Verification and Delivery

Use unittest with mocked network/browser, native dummy schema checks and
localhost SOCKS/browser smoke only. Check Python 3.11 grammar, Bash syntax,
both workflows with actionlint, and whitespace. Review the connected diff.
Commit task-owned files and push to the previously authorized yidu456/dev-plus
without force; preserve AGENTS.md and local journals. Credential-free hosted
Smoke may be used, never dispatch Checkin for validation.
