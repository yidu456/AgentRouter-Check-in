import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import account_observations as observations
import app
import report
import routing


IP = "8.8.8.8"
WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-test"


class CountryLookupTests(unittest.TestCase):
    def query(self, payload, status=200, chunks=None):
        response = Mock(status_code=status)
        response.iter_content.return_value = chunks or [json.dumps(payload).encode("utf-8")]
        session = Mock()
        session.get.return_value = response
        with patch("requests.Session", return_value=session):
            result = observations.query_country(IP)
        self.assertFalse(session.trust_env)
        session.get.assert_called_once_with(
            f"https://ipwho.is/{IP}", params={"fields": "success,ip,country,country_code", "lang": "zh-CN"},
            timeout=5, allow_redirects=False, stream=True,
        )
        response.close.assert_called_once()
        session.close.assert_called_once()
        return result

    def test_country_lookup_uses_explicit_ip_and_minimal_validated_fields(self):
        self.assertEqual(self.query({"success": True, "ip": IP, "country": "美国", "country_code": "US",
                                     "private": "must-not-propagate"}), {"name": "美国", "code": "US"})

    def test_invalid_payload_status_and_oversize_body_return_unknown(self):
        invalid = [[], {}, {"success": False}, {"success": 1, "ip": IP, "country": "US", "country_code": "US"},
                   {"success": True, "ip": "1.1.1.1", "country": "US", "country_code": "US"},
                   {"success": True, "ip": IP, "country": "US\nsecret", "country_code": "US"},
                   {"success": True, "ip": IP, "country": "US", "country_code": "us"}]
        for value in invalid:
            with self.subTest(value=value):
                self.assertIsNone(self.query(value))
        self.assertIsNone(self.query({}, status=429))
        self.assertIsNone(self.query({}, status=302))
        self.assertIsNone(self.query({}, chunks=[b"x" * 4097]))
        self.assertIsNone(self.query({}, chunks=[b'{"success":true,"success":false}']))

    def test_nonpublic_or_invalid_ip_never_queries_any_service(self):
        for ip in (None, "", True, "secret", "203.0.113.10", "127.0.0.1", "::1", "fe80::1%eth0",
                   "224.0.0.1", "ff02::1", "240.0.0.1"):
            with self.subTest(ip=ip), patch("requests.Session") as session:
                self.assertIsNone(observations.query_country(ip))
                session.assert_not_called()

    def test_metadata_query_exception_is_safe_and_closes_session(self):
        session = Mock()
        session.get.side_effect = RuntimeError("private-marker")
        with patch("requests.Session", return_value=session):
            self.assertIsNone(observations.query_country(IP))
        session.close.assert_called_once()

    def test_summary_deduplicates_country_queries_and_preserves_outcomes(self):
        rows = [("one", {"quota": 1, "exit_ip": IP}, "SUCCESS"),
                ("two", {"quota": None, "exit_ip": IP}, "FORM_NOT_FOUND"),
                ("three", {"quota": 0, "exit_ip": None}, "SUCCESS")]
        original = json.dumps(rows)
        with patch.object(observations, "query_country", return_value={"name": "美国", "code": "US"}) as query:
            enriched = observations.enrich_countries(rows)
        query.assert_called_once_with(IP)
        self.assertEqual(enriched[0][1]["country"], {"name": "美国", "code": "US"})
        self.assertEqual(enriched[1][2], "FORM_NOT_FOUND")
        self.assertIsNone(enriched[2][1]["country"])
        self.assertEqual(json.dumps(rows), original)


class UserGroupTests(unittest.TestCase):
    def test_valid_groups_and_bad_metadata_do_not_replace_quota(self):
        for group in ("default", "vip-user", "用户分组", "vip_[x](link)"):
            with self.subTest(group=group):
                self.assertEqual(observations.safe_user_group(group), group)
        for group in (None, True, {}, "", " group ", "x" * 65, "vip\nsecret", "vip\u202e"):
            self.assertIsNone(observations.safe_user_group(group))

        for group, expected in (("default", "default"), ("bad\nsecret", None), (None, None)):
            with self.subTest(group=group), patch.object(app, "browser_login_complete", return_value=(
                    {"quota": 500000, "user_group": group}, "SUCCESS")):
                result, stage = app.checkin_assigned_account({}, [{"server": "http://local"}], {})
            self.assertEqual(stage, "SUCCESS")
            self.assertEqual(result["quota"], 500000)
            self.assertEqual(result.get("user_group"), expected)

    def test_report_preserves_optional_group_and_keeps_old_rows_readable(self):
        group = {"group_id": "g01", "os": "windows-2022", "account_ids": ["a01"], "mode": "isolated"}
        row = {"id": "a01", "quota": 1, "stage": "SUCCESS", "user_group": "default"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "checkin-results-g01" / "result.json"
            path.parent.mkdir()
            report.write_report(path, group, [row])
            detailed = report.combine_reports({"version": 1, "groups": [group]}, root, details=True)
            self.assertEqual(detailed[0][1]["user_group"], "default")
            self.assertEqual(json.loads(path.read_text())["results"][0]["user_group"], "default")
            for bad in (True, "bad\nmarker", "x" * 65):
                with self.subTest(group=bad), self.assertRaisesRegex(ValueError, "^REPORT_INVALID$"):
                    report.write_report(path, group, [dict(row, user_group=bad)])


class LinkedNotificationTests(unittest.TestCase):
    def test_final_report_pipeline_uses_group_country_links_and_markdown_payload(self):
        raw = {"version": 1, "accounts": [{"id": "a01", "username": "dummy@example.test", routing.PASSWORD_KEY: "dummy",
                "os": "windows", "proxies": [{"link": "socks5://proxy.example:1080"}]}],
               "notifications": {"wecom": {"webhook_url": WEBHOOK}, "telegram": {"bot_token": "dummy", "chat_id": "dummy"}}}
        config = routing.parse_config(json.dumps(raw))
        group = routing.build_manifest(config["accounts"])["groups"][0]
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True, "errcode": 0}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "checkin-results-g01" / "result.json"
            path.parent.mkdir()
            report.write_report(path, group, [{"id": "a01", "quota": 500000, "stage": "SUCCESS",
                                              "exit_ip": IP, "user_group": "default"}])
            with patch.dict(os.environ, {"CHECKIN_CONFIG": json.dumps(raw), "CHECKIN_MODE": "isolated",
                    "PREPARE_RESULT": "success"}, clear=True), \
                    patch.object(observations, "query_country", return_value={"name": "美国", "code": "US"}) as country, \
                    patch.object(app.requests, "post", return_value=response) as post:
                self.assertEqual(report._notify(root / "missing.json", root), 0)
        country.assert_called_once_with(IP)
        self.assertEqual(post.call_count, 2)
        self.assertIn('<a href="https://ippure.com/?ip=8.8.8.8">', post.call_args_list[0].kwargs["json"]["text"])
        self.assertEqual(post.call_args_list[0].kwargs["json"]["link_preview_options"], {"is_disabled": True})
        payload = post.call_args_list[1].kwargs["json"]
        self.assertEqual(payload["msgtype"], "markdown")
        self.assertIn("用户分组：default", payload["markdown"]["content"])
        self.assertIn("美国（US）", payload["markdown"]["content"])

    def test_disabled_channels_skip_country_lookup(self):
        config = routing.parse_config(json.dumps({"version": 1, "accounts": [
            {"id": "a01", "username": "dummy@example.test", routing.PASSWORD_KEY: "dummy", "os": "windows",
             "proxies": [{"link": "socks5://proxy.example:1080"}]}]}))
        rows = [("windows-2022 a01", {"quota": 1, "exit_ip": IP}, "SUCCESS")]
        with patch.object(observations, "query_country") as query:
            report.observe_balances(rows, config)
        query.assert_not_called()

    def test_each_channel_gets_clickable_ip_and_escaped_group(self):
        rows = [("a01", {"quota": 500000, "previous_quota": 0, "user_group": "vip_[x](link)<b>",
                         "exit_ip": IP, "country": {"name": "美国", "code": "US"}}, "SUCCESS")]
        html, markdown = app.format_notifications(rows, 1, 1)
        url = f"https://ippure.com/?ip={IP}"
        self.assertIn(f'<a href="{url}">{IP}</a>', html)
        self.assertIn(f"[{IP}]({url})", markdown)
        self.assertIn("美国（US）", html)
        self.assertIn("用户分组", markdown)
        self.assertIn("&lt;b&gt;", html)
        self.assertNotIn("vip_[x](link)", markdown)
        self.assertIn("vip\\_\\[x\\]\\(link\\)", markdown)

    def test_ipv6_links_and_unknown_values(self):
        html, markdown = app.format_notifications([
            ("a01", {"quota": 1, "exit_ip": "2001:4860:4860::8888"}, "SUCCESS"),
            ("a02", {"quota": None}, "FORM_NOT_FOUND")], 1, 2)
        self.assertIn("?ip=2001%3A4860%3A4860%3A%3A8888", html)
        self.assertIn("出口国家：未获取", markdown)
        self.assertIn("用户分组：未获取", markdown)
        self.assertIn("FORM_NOT_FOUND", markdown)

    def test_markdown_wecom_payload_and_dispatch_flag(self):
        response = Mock(status_code=200)
        response.json.return_value = {"errcode": 0}
        with patch.object(app.requests, "post", return_value=response) as post:
            self.assertTrue(app.send_wecom("[IP](https://ippure.com/)", WEBHOOK, markdown=True))
        self.assertEqual(post.call_args.kwargs["json"], {
            "msgtype": "markdown", "markdown": {"content": "[IP](https://ippure.com/)"}})
        with patch.object(app, "send_wecom", return_value=True) as send:
            app.send_notifications("html", "markdown", {"wecom": {"webhook_url": WEBHOOK}}, wecom_markdown=True)
        send.assert_called_once_with("markdown", WEBHOOK, markdown=True)

    def test_generated_long_summaries_never_split_link_syntax(self):
        rows = [(f"a{i}", {"quota": 1, "exit_ip": IP, "user_group": "default"}, "SUCCESS") for i in range(50)]
        html, markdown = app.format_notifications(rows, 50, 50)
        for chunk in app.split_utf8_text(html, limit=3500):
            self.assertEqual(chunk.count("<a "), chunk.count("</a>"))
        for chunk in app.split_utf8_text(markdown):
            self.assertEqual(chunk.count(f"[{IP}]("), chunk.count(f"?ip={IP})"))


if __name__ == "__main__":
    unittest.main()
