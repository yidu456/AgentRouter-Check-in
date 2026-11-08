import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import proxy_runtime
from playwright.sync_api import Error as PlaywrightError


class IsolatedCheckinTests(unittest.TestCase):
    def setUp(self):
        for target, value in (("query_exit_ip", "8.8.8.8"),
                              ("query_country", {"name": "China", "code": "CN", "timezone_id": "Asia/Shanghai"})):
            mock = patch(f"account_observations.{target}", return_value=value)
            mock.start()
            self.addCleanup(mock.stop)

    def worker_environment(self):
        config = {"version": 1, "accounts": [
            {"id": "a01", "site": "https://example.test", "username": "one", "password": "dummy-one",
             "os": "windows", "proxies": [{"link": "socks5://one.test:1080"}]},
            {"id": "a02", "site": "https://example.test", "username": "two", "password": "dummy-two",
             "os": "ubuntu", "proxies": [{"link": "socks5://two.test:1080"}]},
        ]}
        return {"CHECKIN_CONFIG": json.dumps(config), "CHECKIN_MODE": "isolated",
                "GROUP_ID": "g02", "RUNNER_KEY": "windows-2022", "ACCOUNT_IDS": '["a01"]',
                "RESULT_PATH": "dummy-result.json"}

    def test_main_matching_worker_only_forwards_assigned_accounts(self):
        for code in (0, 1):
            with self.subTest(code=code), patch.dict(app.os.environ, self.worker_environment(), clear=True), \
                    patch.object(app.platform, "system", return_value="Windows"), \
                    patch.object(app, "run_isolated_group", return_value=code) as run, \
                    patch.object(app, "send_notifications") as notify:
                with self.assertRaises(SystemExit) as failure:
                    app.main()
                self.assertEqual(failure.exception.code, code)
                self.assertEqual([account["id"] for account in run.call_args.args[0]], ["a01"])
                self.assertEqual(run.call_args.args[1], {"group_id": "g02", "os": "windows-2022",
                                                       "account_ids": ["a01"], "mode": "isolated"})
                self.assertEqual(run.call_args.args[2:], (Path("dummy-result.json"), ""))
                notify.assert_not_called()

    def test_main_worker_rejects_os_runner_group_and_account_mismatch(self):
        cases = [("Linux", {}), ("Windows", {"RUNNER_KEY": "ubuntu-24.04"}),
                 ("Windows", {"GROUP_ID": "g03"}), ("Windows", {"ACCOUNT_IDS": '["a02"]'}),
                 ("Windows", {"ACCOUNT_IDS": '["a01", "a01"]'})]
        for host, overrides in cases:
            env = self.worker_environment()
            env.update(overrides)
            with self.subTest(host=host, overrides=overrides), patch.dict(app.os.environ, env, clear=True), \
                    patch.object(app.platform, "system", return_value=host), \
                    patch.object(app, "run_isolated_group") as run, \
                    patch.object(app, "send_notifications") as notify:
                with self.assertRaises(SystemExit) as failure:
                    app.main()
                self.assertEqual(failure.exception.code, 1)
                run.assert_not_called()
                notify.assert_not_called()

    def test_group_routes_only_owned_candidates_and_writes_safe_results(self):
        profile = {"locale": "zh-CN"}
        routes = [
            {"id": "a02", "profile": profile, "proxies": [{"link": "socks5://two.test:1080"}]},
            {"id": "a01", "profile": profile, "proxies": [
                {"link": "socks5://one.test:1080"}, {"link": "socks5://backup.test:1080"}]},
        ]
        group = {"group_id": "g01", "os": "windows-2022", "account_ids": ["a01", "a02"],
                 "mode": "isolated"}
        endpoints = {"a01_p01": "http://127.0.0.1:18080", "a01_p02": "http://127.0.0.1:18081",
                     "a02_p01": "http://127.0.0.1:18082"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            with patch.object(proxy_runtime, "download_binary", return_value=Path("dummy")), \
                    patch.object(proxy_runtime, "group_proxy") as runtime, \
                    patch.object(proxy_runtime, "load_node_links") as subscription, \
                    patch.object(app, "browser_login_complete", side_effect=[
                        (None, "WAF_TIMEOUT"), ({"quota": 500000}, "SUCCESS"),
                        ({"quota": 1000000}, "SUCCESS")]) as login, \
                    patch.object(app, "send_notifications") as notify:
                runtime.return_value.__enter__.return_value = endpoints
                self.assertEqual(app.run_isolated_group(routes, group, path), 0)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["results"], [
                {"id": "a01", "quota": 500000, "stage": "SUCCESS", "exit_ip": "8.8.8.8",
                 "country": {"name": "China", "code": "CN"}, "timezone_id": "Asia/Shanghai"},
                {"id": "a02", "quota": 1000000, "stage": "SUCCESS", "exit_ip": "8.8.8.8",
                 "country": {"name": "China", "code": "CN"}, "timezone_id": "Asia/Shanghai"},
            ])
        self.assertEqual([(call.args[0]["id"], call.kwargs["proxy"]["server"])
                          for call in login.call_args_list], [
            ("a01", "http://127.0.0.1:18080"), ("a01", "http://127.0.0.1:18081"),
            ("a02", "http://127.0.0.1:18082"),
        ])
        self.assertEqual({tag: outbound["server"] for tag, outbound in runtime.call_args.args[0].items()},
                         {"a01_p01": "one.test", "a01_p02": "backup.test", "a02_p01": "two.test"})
        subscription.assert_not_called()
        notify.assert_not_called()

    def test_group_proxy_start_failure_reports_all_accounts_without_login(self):
        routes = [{"id": "a01", "profile": {}, "proxies": [{"link": "socks5://one.test:1080"}]}]
        group = {"group_id": "g01", "os": "windows-2022", "account_ids": ["a01"], "mode": "isolated"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            with patch.object(proxy_runtime, "download_binary", side_effect=RuntimeError("private")), \
                    patch.object(app, "browser_login_complete") as login, \
                    patch.object(app, "send_notifications") as notify:
                self.assertEqual(app.run_isolated_group(routes, group, path), 1)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["results"], [
                {"id": "a01", "quota": None, "stage": "PROXY_START_FAIL"},
            ])
        login.assert_not_called()
        notify.assert_not_called()

    def test_unexpected_result_shape_is_isolated(self):
        self.assertEqual(app._safe_login_result(["private"], {}), (None, "UNEXPECTED"))
        self.assertEqual(app._safe_login_result(None, []), (None, "UNEXPECTED"))

    def test_fixed_profile_is_forwarded_without_fake_user_agent(self):
        profile = {"locale": "zh-CN", "timezone_id": "Asia/Shanghai",
                   "viewport": {"width": 1440, "height": 900}}
        with patch.object(app, "sync_playwright") as factory:
            browser = factory.return_value.__enter__.return_value.chromium.launch.return_value
            browser.new_context.return_value.new_page.return_value.goto.side_effect = RuntimeError("stop")
            app.browser_login_complete({"site": "http://localhost"},
                                       proxy={"server": "http://127.0.0.1:18080"},
                                       profile=profile, isolated=True)
        browser.new_context.assert_called_once_with(**profile)
        browser.close.assert_called_once()

    def test_ordered_list_stops_on_success(self):
        candidates = [{"server": f"http://127.0.0.1:{port}"} for port in (18080, 18081, 18082)]
        profile = {"locale": "zh-CN"}
        with patch.object(app, "pop_proxy") as pool, \
                patch.object(app, "browser_login_complete", side_effect=[
                    (None, "WAF_TIMEOUT"), ({"quota": 500000}, "SUCCESS")
                ]) as login:
            result = app.checkin_assigned_account({"id": "a01"}, candidates, profile)
        pool.assert_not_called()
        self.assertEqual(result, ({"quota": 500000}, "SUCCESS"))
        self.assertEqual([c.kwargs["proxy"] for c in login.call_args_list], candidates[:2])
        self.assertTrue(all(c.kwargs["profile"] == dict(profile, timezone_id="Asia/Shanghai") and c.kwargs["isolated"]
                            for c in login.call_args_list))

    def test_exhaustion_never_uses_global_or_direct(self):
        with patch.object(app, "PROXY_SERVER", "http://global.example"), \
                patch.object(app, "pop_proxy") as pool, \
                patch.object(app, "browser_login_complete", return_value=(None, "WAF_TIMEOUT")) as login:
            self.assertEqual(app.checkin_assigned_account({}, [{"server": "http://local"}], {}),
                             (None, "WAF_TIMEOUT"))
        pool.assert_not_called()
        self.assertEqual(login.call_count, 1)

    def test_failed_candidates_log_safe_stages_and_preserve_last_failure(self):
        with patch.object(app, "browser_login_complete", side_effect=[
            (None, "BROWSER_LAUNCH_FAIL"), (None, "USER_API_FAIL")
        ]), patch.object(app, "log") as log:
            self.assertEqual(app.checkin_assigned_account({"id": "a01"},
                [{"server": "http://one"}, {"server": "http://two"}], {}), (None, "USER_API_FAIL"))
        self.assertEqual([entry.args[0] for entry in log.call_args_list], [
            "a01 attempt1: BROWSER_LAUNCH_FAIL", "a01 attempt2: USER_API_FAIL"])

    def test_unknown_stages_and_exceptions_never_leak_private_details(self):
        for outcome in ((None, "private-stage"), ({"quota": True}, "SUCCESS"), RuntimeError("private-error")):
            with self.subTest(outcome=outcome), patch.object(app, "browser_login_complete") as login, patch.object(app, "log") as log:
                if isinstance(outcome, Exception):
                    login.side_effect = outcome
                else:
                    login.return_value = outcome
                result, stage = app.checkin_assigned_account({"id": "a01"}, [{"server": "http://local"}], {})
                self.assertIsNone(result)
                self.assertIn(stage, {"UNEXPECTED", "QUOTA_INVALID"})
                self.assertEqual(log.call_args.args[0], f"a01 attempt1: {stage}")
                self.assertNotIn("private", log.call_args.args[0])

    def test_empty_candidates_report_exhaustion_without_starting_browser(self):
        with patch.object(app, "browser_login_complete") as login:
            self.assertEqual(app.checkin_assigned_account({}, [{}, {"server": ""}], {}),
                             (None, "PROXY_LIST_EXHAUSTED"))
        login.assert_not_called()

    def test_navigation_network_error_logs_only_allowlisted_code(self):
        for code in ("ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED",
                     "ERR_SOCKS_CONNECTION_FAILED", "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_REFUSED",
                     "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_RESET", "ERR_SSL_PROTOCOL_ERROR",
                     "ERR_CERT_AUTHORITY_INVALID"):
            with self.subTest(code=code), patch.object(app, "sync_playwright") as factory, patch.object(app, "log") as log:
                browser = factory.return_value.__enter__.return_value.chromium.launch.return_value
                page = browser.new_context.return_value.new_page.return_value
                page.goto.side_effect = PlaywrightError(f"net::{code} at https://private.example/login?key=private-token")
                self.assertEqual(app.browser_login_complete({"site": "https://example.test"},
                    proxy={"server": "http://local"}, isolated=True), (None, "NODE_UNREACHABLE"))
                log.assert_called_once_with(f"NAVIGATION_FAIL: {code}")
                browser.close.assert_called_once()

    def test_unrecognized_navigation_error_stays_private(self):
        with patch.object(app, "sync_playwright") as factory, patch.object(app, "log") as log:
            browser = factory.return_value.__enter__.return_value.chromium.launch.return_value
            page = browser.new_context.return_value.new_page.return_value
            page.goto.side_effect = PlaywrightError("private-error at https://private.example/?key=private-token")
            self.assertEqual(app.browser_login_complete({"site": "https://example.test"},
                proxy={"server": "http://local"}, isolated=True), (None, "UNEXPECTED"))
            log.assert_not_called()
            browser.close.assert_called_once()

    def test_browser_refuses_missing_isolated_endpoint(self):
        with patch.object(app, "PROXY_SERVER", "http://global.example"), \
                patch.object(app, "sync_playwright") as browser:
            self.assertEqual(app.browser_login_complete({}, isolated=True),
                             (None, "NODE_UNREACHABLE"))
        browser.assert_not_called()

    def test_candidate_exception_does_not_stop_list(self):
        with patch.object(app, "browser_login_complete", side_effect=[
            RuntimeError("private"), ({"quota": 1}, "SUCCESS")
        ]):
            result = app.checkin_assigned_account({}, [{"server": "one"}, {"server": "two"}], {})
        self.assertEqual(result[1], "SUCCESS")

    def test_worker_failure_never_sends_notification(self):
        with patch.dict(app.os.environ, {"GROUP_ID": "g01", "CHECKIN_MODE": "isolated",
                                         "CHECKIN_CONFIG": "bad-json"}, clear=True), \
                patch.object(app, "send_notifications") as notify:
            with self.assertRaises(SystemExit) as failure:
                app.main()
        self.assertEqual(failure.exception.code, 1)
        notify.assert_not_called()

    def test_legacy_failure_continues_and_reports_before_notifying(self):
        accounts = [{"site": "https://example.com", "username": "one"},
                    {"site": "https://example.com", "username": "two"}]
        group = {"group_id": "legacy", "os": "ubuntu-24.04",
                 "account_ids": ["legacy001", "legacy002"], "mode": "legacy"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            with patch.object(app, "parse_accounts", return_value=accounts), \
                    patch.object(app, "checkin_account", side_effect=[
                        (None, "NO_PROXY"), ({"quota": 500000}, "SUCCESS")
                    ]) as login, patch.object(app.time, "sleep"), \
                    patch.object(app, "send_notifications") as notify:
                with self.assertRaises(SystemExit):
                    app.run_checkin(notify=False, manifest_group=group, result_path=path)
            self.assertEqual(login.call_count, 2)
            notify.assert_not_called()
            rows = json.loads(path.read_text(encoding="utf-8"))["results"]
            self.assertEqual([r["stage"] for r in rows], ["NO_PROXY", "SUCCESS"])


if __name__ == "__main__":
    unittest.main()
