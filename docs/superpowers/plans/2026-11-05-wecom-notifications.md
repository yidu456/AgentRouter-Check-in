# WeCom Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not begin runtime changes until the user approves the design.

**Goal:** Add optional WeCom delivery from CHECKIN_CONFIG.notifications while preserving Telegram and login behavior.

**Architecture:** Keep notification helpers in app.py and reuse requests/log/send_telegram. Produce separate Telegram HTML and WeCom plain-text summaries from the existing result rows. Channel failures are independent and do not decide login success. Helpers accept the explicit notifications subobject; None preserves legacy Telegram only, while {} disables all channels.

**Tech Stack:** Python 3.11, requests, standard-library unittest/mock; current Playwright is needed to import app.py but no browser is needed for unit tests.

**Spec:** docs/superpowers/specs/2026-11-05-multi-os-isolation-wecom-design.md, sections 2, 8, 9, and 10.

## Global Constraints

- No new runtime dependencies or test framework.
- CHECKIN_CONFIG is the only new user-facing Secret. Bot settings are notifications.telegram/wecom fields; never print keys, URLs, responses, or exceptions.
- WeCom text <=2048 UTF-8 bytes per message; sends spaced at least 3.1 seconds.
- HTTP timeout 30 seconds; disable redirects; successful integer errcode == 0 required; no automatic retries.
- Telegram-only, WeCom-only, both, neither remain valid configurations.
- Preserve current Telegram output and login exit codes.
- This plan is implementable independently before the multi-OS plan.

## File Map

- Modify app.py: configuration, transport, chunking, summary dispatch, fatal notification dispatch.
- Workflow wiring occurs in the multi-OS plan: pass the single CHECKIN_CONFIG Secret, not a second bot variable.
- Modify README.md: group-webhook setup and optional-channel behavior.
- Create tests/test_notifications.py: all HTTP/time/browser calls mocked.

### Task 1: WeCom Transport and UTF-8 Chunking

**Interfaces:**
- Produces `split_utf8_text(message: str, limit: int = 2048) -> list[str]`.
- Produces `send_wecom(message: str, webhook_url: str = "") -> bool`; explicit URL only. Extend send_telegram(message, token=None, chat_id=None); None uses legacy env, explicit empty disables.
- send_wecom returns false when unconfigured, invalid, rejected, or any chunk fails; true only when all nonempty chunks are accepted.

- [x] **Step 1: Write failing unit tests.** Include this baseline in tests/test_notifications.py:

```python
import unittest
from unittest.mock import Mock, patch
import app

WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-test"

class WeComTests(unittest.TestCase):
    def test_success_payload(self):
        response = Mock(status_code=200)
        response.json.return_value = {"errcode": 0, "errmsg": "ok"}
        with patch.object(app.requests, "post", return_value=response) as post:
            self.assertTrue(app.send_wecom("balance $1.00", WEBHOOK))
        post.assert_called_once_with(
            WEBHOOK,
            json={"msgtype": "text", "text": {"content": "balance $1.00"}},
            timeout=30,
            allow_redirects=False,
        )

    def test_unicode_content_is_preserved(self):
        message = "\u7b7e\u5230\U0001f381" * 900
        chunks = app.split_utf8_text(message)
        self.assertEqual("".join(chunks), message)
        self.assertTrue(all(len(c.encode("utf-8")) <= 2048 for c in chunks))

    def test_line_boundaries(self):
        message = "a" * 1000 + "\n" + "b" * 1500
        chunks = app.split_utf8_text(message)
        self.assertEqual(chunks[0], "a" * 1000 + "\n")
        self.assertEqual("".join(chunks), message)
```

Also add subtests for absent/invalid URL, HTTP 302/500, nonzero/missing/bool errcode, non-object JSON, JSON decode failure, timeout, and empty message. Patch requests.post to assert invalid/unconfigured inputs never make a request. Capture stdout and assert webhook/key/response/exception text never appear. A three-chunk success requires exactly two sleep(3.1) calls; failure stops further chunks with no retry.

- [x] **Step 2: Run the tests and confirm the missing new API fails.**

```bash
python -m unittest discover -s tests -p test_notifications.py -v
```

- [x] **Step 3: Implement chunking and URL validation in app.py.** Use this chunking algorithm; preserve newline characters in output:

```python
def split_utf8_text(message, limit=2048):
    if limit < 4:
        raise ValueError("INVALID_TEXT_LIMIT")
    chunks, current, size = [], "", 0
    for line in message.splitlines(keepends=True):
        line_size = len(line.encode("utf-8"))
        if line_size <= limit:
            if current and size + line_size > limit:
                chunks.append(current)
                current, size = "", 0
            current += line
            size += line_size
            continue
        if current:
            chunks.append(current)
            current, size = "", 0
        for char in line:
            char_size = len(char.encode("utf-8"))
            if size + char_size > limit:
                chunks.append(current)
                current, size = "", 0
            current += char
            size += char_size
    if current:
        chunks.append(current)
    return chunks
```

Parse the URL with urllib.parse.urlsplit/parse_qs. Require HTTPS, exact hostname qyapi.weixin.qq.com, no userinfo/fragment, default HTTPS port, exact /cgi-bin/webhook/send path, and query keys exactly {key} with one nonempty value. Catch malformed port parsing. Reject a blank message before HTTP work.

- [x] **Step 4: Implement send_wecom with one POST per chunk.**

```python
response = requests.post(
    webhook_url,
    json={"msgtype": "text", "text": {"content": chunk}},
    timeout=30,
    allow_redirects=False,
)
if not 200 <= response.status_code < 300:
    return False
payload = response.json()
if not isinstance(payload, dict):
    return False
code = payload.get("errcode")
if type(code) is not int or code != 0:
    return False
```

Wrap the request/JSON path in exception handling returning false without printing details. Sleep 3.1 before each chunk after the first, not after the final chunk. Do not set requests-level retries. Reuse log only for safe overall channel status.

- [x] **Step 5: Run the same tests, confirm all edge cases pass, and inspect the diff.** Commit only this task's files after verification if committing is authorized:

```bash
git add app.py tests/test_notifications.py
git commit -m "feat: add optional WeCom webhook notifications"
```

### Task 2: Independent Channel Dispatch and Existing Summary Integration

**Interfaces:**
- Consumes send_wecom/send_telegram.
- Produces `send_notifications(telegram_message: str, plain_message: str, config: dict | None = None) -> dict[str, bool | None]` with keys telegram/wecom; None outcomes mean unconfigured. config is the notifications subobject; None config retains legacy Telegram, {} never inherits old env values.
- Produces `format_notifications(results: list[tuple[str, str | None, str]], success_count: int, total: int) -> tuple[str, str]`; returns HTML/plain text.
- report.py in the multi-OS plan consumes these two functions without changing their signatures.

- [x] **Step 1: Add failing integration tests.**

```python
def test_wecom_failure_does_not_block_telegram(self):
    config = {"telegram":{"bot_token":"unit-token","chat_id":"unit-chat"},
              "wecom":{"webhook_url":WEBHOOK}}
    with patch.object(app, "send_telegram", return_value=True) as telegram, \
         patch.object(app, "send_wecom", return_value=False) as wecom:
        result = app.send_notifications("<b>summary</b>", "summary", config=config)
    self.assertEqual(result, {"telegram":True,"wecom":False})
    telegram.assert_called_once_with("<b>summary</b>", token="unit-token", chat_id="unit-chat")
    wecom.assert_called_once_with("summary", WEBHOOK)
```

Test explicit config=None legacy versus config={} disabled (including preexisting old bot env), explicit Telegram parameters, and all four JSON channel combinations, Telegram failure with WeCom success, and unexpected helper exceptions independently. Test success/failure rows, exact existing Telegram headers/footer, HTML escaping of labels, and no HTML tags in WeCom text. Mock checkin_account/parse_accounts/time.sleep in run_checkin tests; one failed account still processes the next and raises SystemExit(1) only after summary dispatch.

- [x] **Step 2: Run tests and observe failure before editing integration.**

```bash
python -m unittest discover -s tests -p test_notifications.py -v
```

- [x] **Step 3: Implement the dispatcher and factor existing formatting.**

```python
settings = {"telegram":{"bot_token":TG_BOT_TOKEN,"chat_id":TG_CHAT_ID}} if config is None else config
outcomes = {"telegram":None,"wecom":None}
telegram, wecom = settings.get("telegram",{}), settings.get("wecom",{})
if telegram.get("bot_token") and telegram.get("chat_id"):
    try:
        outcomes["telegram"] = send_telegram(telegram_message,
            token=telegram["bot_token"], chat_id=telegram["chat_id"])
    except Exception:
        outcomes["telegram"] = False
if wecom.get("webhook_url"):
    try:
        outcomes["wecom"] = send_wecom(plain_message, wecom["webhook_url"])
    except Exception:
        outcomes["wecom"] = False
return outcomes
```

Move the existing Telegram message_lines block from run_checkin into format_notifications, preserving its output. Escape labels with html.escape for HTML; build the plain variant from the same result rows without adding HTML. Replace the run_checkin send_telegram call with format_notifications + send_notifications. Replace main's generic fatal notification with both-channel dispatch, keeping the exception type/stage-only log and exit code 1.

- [x] **Step 4: Document bots inside the single variable.** CHECKIN_CONFIG.notifications.telegram contains bot_token/chat_id; notifications.wecom contains webhook_url. No new separate bot Secret is introduced. Workflow wiring happens with the matrix plan. Document group webhook creation, optional channels, pacing/chunking, ambiguous-failure/no-retry, and no real configuration in screenshots/logs.

Resolve explicit Telegram credentials using TG_BOT_TOKEN if token is None else token, likewise chat_id; never use token or TG_BOT_TOKEN. New-mode summary/fatal calls pass the parsed notifications object, including {}; legacy calls use config=None. The configuration parser is added by the multi-OS plan before workflow activation.

- [x] **Step 5: Verify without sending real messages.**

```bash
python -m py_compile app.py
python -m unittest discover -s tests -v
bash -n setup-proxy.sh
git diff --check
```

If bash is unavailable on Windows, run Bash syntax in the Ubuntu verification job and report the local gap. After checks, commit only task-owned files if authorized:

```bash
git add app.py README.md tests/test_notifications.py
git commit -m "feat: integrate independent check-in notification channels"
```

## Acceptance and Handoff

Explicit WeCom helper/dispatcher APIs are testable before the complete JSON/matrix entry point is wired; no real account login or bot send is part of these unit tests. User-authorized delivery tests must use a dedicated test group. Continue with docs/superpowers/plans/2026-11-05-multi-os-isolation.md only after this increment is reviewed.

## Implementation Evidence (2026-11-06)

Implemented on dev-plus without commits or pushes. Twelve mocked notification tests pass; UTF-8 segmentation, independent channel dispatch, explicit disabled-channel handling, safe webhook/API checks and no transport retries are covered. Python/Bash syntax and diff checks pass. Transport is invoked only by the final aggregation job in Actions. Real bot delivery remains untested and requires separate user approval.
