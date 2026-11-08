import contextlib
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import account_observations as observations
import app
import report
import routing
from urllib3.exceptions import ReadTimeoutError


class ActionableFeedbackTests(unittest.TestCase):
    def test_exit_query_explains_http_timeout_and_bad_payload_without_private_response(self):
        for status, body, failure, expected in [(503, b"private-response", None, "EXIT_HTTP_ERROR"),
                (200, b"private-response", None, "EXIT_RESPONSE_INVALID"),
                (200, b"x" * 129, None, "EXIT_RESPONSE_TOO_LARGE"),
                (200, b"", app.requests.Timeout("private-error"), "EXIT_TIMEOUT")]:
            response = Mock(status_code=status)
            response.iter_content.return_value = [body]
            session = Mock()
            session.get.return_value = response
            session.get.side_effect = failure
            output = io.StringIO()
            with self.subTest(expected=expected), patch("requests.Session", return_value=session), \
                    contextlib.redirect_stdout(output):
                self.assertIsNone(observations.query_exit_ip({"server": "http://127.0.0.1:18080"}))
            self.assertIn(expected, output.getvalue())
            self.assertIn("处理：", output.getvalue())
            self.assertNotIn("private", output.getvalue())
            if failure is None:
                response.close.assert_called_once()
            session.close.assert_called_once()

    def test_bad_windows_id_has_safe_cause_remedy_annotation_and_summary(self):
        config = {"version": 2, "groups": {"windows": {"accounts": [{
            "id": "1-private-id", "username": "private@example.test", "password": "private-password",
            "proxies": [{"link": "socks5://private-proxy.example:1080"}],
        }]}}}
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / "summary.md"
            output = io.StringIO()
            with patch.dict(os.environ, {"CHECKIN_CONFIG": json.dumps(config), "GITHUB_ACTIONS": "true",
                    "GITHUB_STEP_SUMMARY": str(summary)}, clear=True), contextlib.redirect_stderr(output), \
                    contextlib.redirect_stdout(output):
                code = routing.main(["prepare", "--manifest", str(Path(directory) / "manifest.json")])
            text = output.getvalue()
            self.assertEqual(code, 1)
            self.assertIn("field=groups.windows.accounts[0].id reason=INVALID_CHOICE", text)
            self.assertIn("Windows 组第 1 个账号", text)
            self.assertIn("1～32", text)
            self.assertIn("英文字母", text)
            self.assertIn("处理：", text)
            self.assertIn("::error", text)
            self.assertTrue(summary.exists())
            self.assertIn("win01", summary.read_text(encoding="utf-8"))
            self.assertIn("reason=INVALID_CHOICE", summary.read_text(encoding="utf-8"))
            self.assertIn("field=groups.windows.accounts[0].id", summary.read_text(encoding="utf-8"))
            annotation = next(line for line in text.splitlines() if line.startswith("::error"))
            self.assertIn("reason=INVALID_CHOICE", annotation)
            for secret in ("1-private-id", "private@example.test", "private-password", "private-proxy.example"):
                self.assertNotIn(secret, text + summary.read_text(encoding="utf-8"))

    def test_help_sanitizes_untrusted_diagnostic_fields_and_keeps_counts_useful(self):
        text = routing.diagnostic_help({"field": "subscription_url", "reason": "POOL_TOO_SMALL",
                                        "available": 1, "requested": 6})
        self.assertIn("1", text)
        self.assertIn("6", text)
        self.assertIn("减少", text)
        self.assertNotIn("private", routing.diagnostic_help({"field": "private", "reason": "private"}))

    def test_notify_config_failure_also_explains_field_without_sending(self):
        config = {"version": 2, "groups": {"windows": {"accounts": [{
            "id": "1-private", "username": "private@example.test", "password": "private-password",
            "proxies": [{"link": "socks5://private.example:1080"}],
        }]}}}
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "CHECKIN_CONFIG": json.dumps(config), "PREPARE_RESULT": "failure"}, clear=True), \
                patch.object(app, "send_notifications") as send, contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(output):
            self.assertEqual(report._notify(Path(directory) / "manifest.json", Path(directory)), 1)
        send.assert_not_called()
        self.assertIn("Windows 组第 1 个账号", output.getvalue())
        self.assertIn("处理：", output.getvalue())
        self.assertNotIn("1-private", output.getvalue())

    def test_copy_buttons_follow_split_messages_and_deduplicate_same_ip(self):
        rows = [(f"a{n}", {"quota": 1, "exit_ip": f"8.8.4.{n}"}, "SUCCESS") for n in range(1, 51)]
        rows.append(("repeat", {"quota": 1, "exit_ip": f"8.8.4.{50}"}, "SUCCESS"))
        html, _ = app.format_notifications(rows, 51, 51)
        response = Mock()
        response.json.return_value = {"ok": True}
        with patch.object(app.requests, "post", return_value=response) as post, patch.object(app.time, "sleep"):
            self.assertTrue(app.send_telegram(html, token="dummy", chat_id="dummy"))
        self.assertGreater(post.call_count, 1)
        copied = set()
        for call in post.call_args_list:
            payload = call.kwargs["json"]
            ips = [row[0]["copy_text"]["text"] for row in payload.get("reply_markup", {}).get("inline_keyboard", [])]
            self.assertEqual(len(ips), len(set(ips)))
            self.assertTrue(all(f"<code>{ip}</code>" in payload["text"] for ip in ips))
            copied.update(ips)
        self.assertEqual(copied, {f"8.8.4.{n}" for n in range(1, 51)})

    def test_summary_storage_failure_does_not_hide_original_failure(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_STEP_SUMMARY": "unused"}, clear=True), \
                patch("builtins.open", side_effect=OSError("private")), contextlib.redirect_stdout(io.StringIO()) as output:
            routing.emit_help("安全提示", error=True)
        self.assertIn("::error", output.getvalue())
        self.assertNotIn("private", output.getvalue())

    def test_real_streaming_response_distinguishes_wrapped_timeout_from_other_read_errors(self):
        for error, expected in [(ReadTimeoutError(None, None, "private-timeout"), "EXIT_TIMEOUT"),
                                (OSError("private-read-error"), "EXIT_READ_FAIL")]:
            response = app.requests.Response()
            response.status_code = 200
            response.raw = Mock()
            response.raw.stream.side_effect = error
            session = Mock()
            session.get.return_value = response
            output = io.StringIO()
            with self.subTest(expected=expected), patch("requests.Session", return_value=session), \
                    contextlib.redirect_stdout(output):
                self.assertIsNone(observations.query_exit_ip({"server": "http://127.0.0.1:18080"}))
                self.assertIn(expected, output.getvalue())
                self.assertNotIn("private", output.getvalue())
                response.raw.close.assert_called_once()
                session.close.assert_called_once()

    def test_closed_stdout_does_not_break_node_fallback_or_summary(self):
        closed = io.StringIO()
        closed.close()
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / "summary.md"
            with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_STEP_SUMMARY": str(summary)}, clear=True), \
                    contextlib.redirect_stdout(closed):
                routing.emit_help("安全提示", error=True)
            self.assertIn("安全提示", summary.read_text(encoding="utf-8"))

    def test_all_report_failures_have_cause_and_remedy_and_notification_keeps_code(self):
        for stage in report.FAILURE_STAGES:
            with self.subTest(stage=stage):
                text = routing.failure_help(stage)
                self.assertIn("原因：", text)
                self.assertIn("处理：", text)
        html, plain = app.format_notifications([("a01", {"quota": None}, "EXIT_IP_FAIL")], 0, 1)
        for text in (html, plain):
            self.assertIn("EXIT_IP_FAIL", text)
            self.assertIn("原因：", text)
            self.assertIn("处理：", text)

    def test_three_nodes_advance_without_credentials_until_valid_ip_and_refresh_locale(self):
        candidates = [{"server": f"http://127.0.0.1:{18080 + n}"} for n in range(3)]
        location = {"name": "Japan", "code": "JP", "timezone_id": "Asia/Tokyo"}
        detail, output = {}, io.StringIO()
        with patch.object(observations, "query_exit_ip", side_effect=[None, None, "8.8.8.8"]) as ip, \
                patch.object(observations, "query_country", return_value=location), \
                patch.object(app, "browser_login_complete", return_value=({"quota": 1}, "SUCCESS")) as login, \
                contextlib.redirect_stdout(output):
            result = app.checkin_assigned_account({"id": "a01"}, candidates, {"locale": "auto"}, detail)
        self.assertEqual(result, ({"quota": 1}, "SUCCESS"))
        self.assertEqual([c.args[0] for c in ip.call_args_list], candidates)
        login.assert_called_once()
        self.assertEqual(login.call_args.kwargs["proxy"], candidates[2])
        self.assertEqual(login.call_args.kwargs["profile"], {"locale": "ja-JP", "timezone_id": "Asia/Tokyo"})
        self.assertEqual(detail["country"]["code"], "JP")
        self.assertIn("切换到候选 2/3", output.getvalue())
        self.assertIn("切换到候选 3/3", output.getvalue())

    def test_exhaustion_explains_all_attempts_and_never_uses_direct_or_global_proxy(self):
        output = io.StringIO()
        with patch.object(observations, "query_exit_ip", return_value=None) as ip, \
                patch.object(app, "browser_login_complete") as login, patch.object(app, "pop_proxy") as pool, \
                contextlib.redirect_stdout(output):
            result = app.checkin_assigned_account({"id": "a01"}, [{"server": "http://one"}] * 3, {})
        self.assertEqual(result, (None, "EXIT_IP_FAIL"))
        self.assertEqual(ip.call_count, 3)
        login.assert_not_called()
        pool.assert_not_called()
        self.assertIn("已尝试 3 个", output.getvalue())

    def test_auto_locale_country_mapping_fallback_and_fixed_values(self):
        for code, expected in [("SG", "en-SG"), ("KR", "ko-KR"), ("JP", "ja-JP"), ("DE", "de-DE"),
                               ("US", "en-US"), ("HK", "zh-HK"), ("ZZ", "en-US")]:
            profile = routing._profile({"locale": "auto"})
            with self.subTest(code=code), patch.object(observations, "query_exit_ip", return_value="8.8.8.8"), \
                    patch.object(observations, "query_country", return_value={
                        "name": "Country", "code": code, "timezone_id": "Asia/Tokyo"}), \
                    patch.object(app, "browser_login_complete", return_value=({"quota": 1}, "SUCCESS")) as login:
                app.checkin_assigned_account({}, [{"server": "http://one"}], profile)
                self.assertEqual(login.call_args.kwargs["profile"]["locale"], expected)
                self.assertEqual(profile["locale"], "auto")
        self.assertEqual(routing._profile({})["locale"], "zh-CN")

    def test_country_changes_on_login_fallback_and_fixed_locale_is_preserved(self):
        for locale, expected in [("auto", ["ko-KR", "de-DE"]), ("zh-CN", ["zh-CN", "zh-CN"])]:
            with self.subTest(locale=locale), patch.object(observations, "query_exit_ip", side_effect=["1.1.1.1", "8.8.8.8"]), \
                    patch.object(observations, "query_country", side_effect=[
                        {"name": "Korea", "code": "KR", "timezone_id": "Asia/Seoul"},
                        {"name": "Germany", "code": "DE", "timezone_id": "Europe/Berlin"}]), \
                    patch.object(app, "browser_login_complete", side_effect=[
                        (None, "WAF_TIMEOUT"), ({"quota": 1}, "SUCCESS")]) as login:
                detail = {}
                app.checkin_assigned_account({}, [{"server": "http://one"}, {"server": "http://two"}],
                                             {"locale": locale}, detail)
                self.assertEqual([c.kwargs["profile"]["locale"] for c in login.call_args_list], expected)
                self.assertEqual(detail["timezone_id"], "Europe/Berlin")
                self.assertEqual(detail["exit_ip"], "8.8.8.8")

    def test_native_copy_buttons_only_include_valid_ip_in_their_message_chunk(self):
        rows = [("a01", {"quota": 1, "exit_ip": "8.8.8.8"}, "SUCCESS"),
                ("a02", {"quota": 1, "exit_ip": "2001:4860:4860::8888"}, "SUCCESS"),
                ("a03", {"quota": None, "exit_ip": "private-invalid"}, "EXIT_IP_FAIL")]
        html, plain = app.format_notifications(rows, 2, 3)
        self.assertNotIn("ippure", html + plain)
        self.assertIn("<code>8.8.8.8</code>", html)
        response = Mock()
        response.json.return_value = {"ok": True}
        with patch.object(app.requests, "post", return_value=response) as post:
            self.assertTrue(app.send_telegram(html, token="dummy", chat_id="dummy"))
        buttons = post.call_args.kwargs["json"]["reply_markup"]["inline_keyboard"]
        self.assertEqual([row[0]["copy_text"]["text"] for row in buttons], ["8.8.8.8", "2001:4860:4860::8888"])
        self.assertTrue(all("url" not in row[0] for row in buttons))
        self.assertNotIn("private-invalid", html + plain)

    def test_summary_footer_is_shanghai_time_for_success_failure_and_empty_rows(self):
        instant = datetime(2026, 11, 9, 0, 1, 2, tzinfo=timezone(timedelta(hours=8)))
        with patch.object(app, "datetime", create=True) as clock:
            clock.now.return_value = instant
            for rows in ([], [("a01", None, "EXIT_IP_FAIL")], [("a01", {"quota": 1}, "SUCCESS")]):
                html, plain = app.format_notifications(rows, 0, len(rows))
                self.assertEqual(html.splitlines()[-1], "运行时间：2026-11-09 00:01:02（北京时间 UTC+8）")
                self.assertEqual(plain.splitlines()[-1], html.splitlines()[-1])
            self.assertEqual(clock.now.call_args.args[0].utcoffset(None), timedelta(hours=8))
