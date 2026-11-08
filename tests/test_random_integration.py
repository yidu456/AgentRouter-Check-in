import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import report
import routing


def configuration():
    return {"version": 1, "subscription_url": "https://subscription.example/sub", "accounts": [
        {"id": "a01", "username": "unit@example.test", "password": "dummy-secret", "os": "windows",
         "proxies": [{"random": 2}, {"link": "socks5://fixed.example:1080"}, {"random": 1}]},
        {"id": "a02", "username": "two@example.test", "password": "dummy-secret", "os": "macos",
         "proxies": [{"random": 1}]},
    ]}


class RandomRoutingTests(unittest.TestCase):
    def test_random_entries_preserve_order_and_count_against_expanded_limit(self):
        value = configuration()
        parsed = routing.parse_config(json.dumps(value))
        self.assertEqual(parsed["accounts"][0]["proxies"], value["accounts"][0]["proxies"])
        with patch.object(routing, "MAX_CANDIDATES", 4):
            with self.assertRaisesRegex(ValueError, "^ROUTE_CONFIG_FAIL$"):
                routing.parse_config(json.dumps(value))

    def test_random_rejects_invalid_count_missing_subscription_and_internal_outbound(self):
        for count in (True, False, 0, -1, 1.1, "2", None, 47457):
            value = configuration()
            value["accounts"][0]["proxies"] = [{"random": count}]
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "^ROUTE_CONFIG_FAIL$"):
                routing.parse_config(json.dumps(value))
        for proxies in ([{"outbound": {"server": "private"}}], [{"random": 1, "node": "name"}]):
            value = configuration()
            value["accounts"][0]["proxies"] = proxies
            with self.assertRaisesRegex(ValueError, "^ROUTE_CONFIG_FAIL$"):
                routing.parse_config(json.dumps(value))
        value = configuration()
        value.pop("subscription_url")
        with self.assertRaisesRegex(ValueError, "^ROUTE_CONFIG_FAIL$"):
            routing.parse_config(json.dumps(value))

    def test_prepare_stores_only_plan_metadata_and_assign_exports_it(self):
        import subscription_pool

        metadata = {"seed": "a" * 32, "fingerprint": "b" * 64}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, env = root / "manifest.json", root / "env"
            with patch.dict(os.environ, {"CHECKIN_CONFIG": json.dumps(configuration())}, clear=True), \
                    patch.object(subscription_pool, "load_pool", return_value=({}, [])) as load, \
                    patch.object(subscription_pool, "make_plan", return_value=metadata), \
                    contextlib.redirect_stdout(io.StringIO()):
                routing._prepare(manifest)
            public = json.loads(manifest.read_text())
            self.assertEqual(public["random"], metadata)
            self.assertNotIn("dummy-secret", manifest.read_text())
            self.assertNotIn("fixed.example", manifest.read_text())
            load.assert_called_once_with("https://subscription.example/sub", require_names=False)
            with patch.dict(os.environ, {"GITHUB_ENV": str(env)}, clear=True):
                routing._assign(manifest, 1, "windows-2022")
            assigned = dict(line.split("=", 1) for line in env.read_text().splitlines())
            self.assertEqual(json.loads(assigned["RANDOM_PLAN"]), metadata)

    def test_manifest_random_schema_is_strict_and_isolated_only(self):
        group = {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["a01"], "mode": "isolated"}
        public = {"version": 1, "groups": [group], "random": {"seed": "a" * 32, "fingerprint": "b" * 64}}
        report._validate_manifest(public)
        for metadata in ({}, {"seed": "a" * 31, "fingerprint": "b" * 64},
                         {"seed": "a" * 32, "fingerprint": "b" * 64, "nodes": "private"},
                         {"seed": "A" * 32, "fingerprint": "b" * 64}):
            with self.subTest(metadata=metadata), self.assertRaisesRegex(ValueError, "^REPORT_INVALID$"):
                report._validate_manifest(dict(public, random=metadata))
        with self.assertRaisesRegex(ValueError, "^REPORT_INVALID$"):
            report._validate_manifest(dict(public, groups=[dict(group, mode="legacy")]))


class RandomWorkerTests(unittest.TestCase):
    def test_workers_rebuild_one_shared_disjoint_plan_before_selecting_their_group(self):
        import subscription_pool
        import proxy_runtime

        config = routing.parse_config(json.dumps(configuration()))
        nodes = [proxy_runtime.parse_node_link(f"socks5://pool{i}.example:1080", "pool") for i in range(5)]
        plan = subscription_pool.make_plan(config, {}, nodes, seed="a" * 32)
        selected = []
        for group in routing.build_manifest(config["accounts"])["groups"]:
            os_name = "Windows" if group["os"] == "windows-2022" else "Darwin"
            with tempfile.TemporaryDirectory() as directory, \
                    patch.dict(os.environ, {"CHECKIN_CONFIG": json.dumps(configuration()), "GROUP_ID": group["group_id"],
                        "CHECKIN_MODE": "isolated", "RUNNER_KEY": group["os"],
                        "ACCOUNT_IDS": json.dumps(group["account_ids"]), "RANDOM_PLAN": json.dumps(plan),
                        "RESULT_PATH": str(Path(directory) / "result.json")}, clear=True), \
                    patch.object(app.platform, "system", return_value=os_name), \
                    patch.object(subscription_pool, "load_pool", return_value=({}, list(reversed(nodes)))) as load, \
                    patch.object(app, "run_isolated_group", return_value=0) as run, \
                    patch.object(app, "send_notifications") as notify, self.assertRaises(SystemExit) as exited:
                app.main()
            self.assertEqual(exited.exception.code, 0)
            load.assert_called_once()
            notify.assert_not_called()
            selected.extend(run.call_args.args[0])
        self.assertEqual({a["id"] for a in selected}, {"a01", "a02"})
        identities = [p["outbound"]["server"] for a in selected for p in a["proxies"] if "outbound" in p]
        self.assertEqual(len(identities), 4)
        self.assertEqual(len(set(identities)), 4)
        self.assertEqual(len(selected[0]["proxies"]), 4)
        self.assertEqual(selected[0]["proxies"][2], {"link": "socks5://fixed.example:1080"})

    def test_local_multiple_groups_fetch_and_allocate_once_and_send_only_final(self):
        import subscription_pool
        import proxy_runtime

        value = configuration()
        value["accounts"] = [dict(value["accounts"][1], id=f"a{i}", username=f"u{i}@example.test", os="windows")
                             for i in range(4)]
        nodes = [proxy_runtime.parse_node_link(f"socks5://pool{i}.example:1080", "pool") for i in range(4)]

        def run_group(routes, group, path, subscription_url):
            report.write_report(path, group, [{"id": a["id"], "quota": 0, "stage": "SUCCESS"} for a in routes])
            return 0

        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"CHECKIN_CONFIG": json.dumps(value),
                    "BALANCE_HISTORY_PATH": str(Path(directory) / "history.json")}, clear=True), \
                patch.object(app.platform, "system", return_value="Windows"), \
                patch.object(subscription_pool, "load_pool", return_value=({}, nodes)) as load, \
                patch.object(app, "run_isolated_group", side_effect=run_group) as run, \
                patch.object(app, "send_notifications") as notify, self.assertRaises(SystemExit) as exited:
            app.main()
        self.assertEqual(exited.exception.code, 0)
        load.assert_called_once()
        self.assertEqual(run.call_count, 2)
        notify.assert_called_once()

    def test_pool_failure_reports_only_assigned_accounts_before_login_or_binary(self):
        import subscription_pool
        import proxy_runtime

        value = configuration()
        env = {"CHECKIN_CONFIG": json.dumps(value), "GROUP_ID": "g01", "CHECKIN_MODE": "isolated",
               "RUNNER_KEY": "windows-2022", "ACCOUNT_IDS": '["a01"]',
               "RANDOM_PLAN": json.dumps({"seed": "a" * 32, "fingerprint": "b" * 64})}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            with patch.dict(os.environ, dict(env, RESULT_PATH=str(path)), clear=True), \
                    patch.object(app.platform, "system", return_value="Windows"), \
                    patch.object(subscription_pool, "load_pool", side_effect=ValueError("private-marker")), \
                    patch.object(app, "run_isolated_group") as run, \
                    patch.object(proxy_runtime, "download_binary") as binary, \
                    patch.object(app, "send_notifications") as notify, \
                    self.assertRaises(SystemExit) as exit_code:
                app.main()
            self.assertEqual(exit_code.exception.code, 1)
            data = json.loads(path.read_text())
            self.assertEqual(data["results"], [{"id": "a01", "quota": None, "stage": "RANDOM_POOL_FAIL"}])
            self.assertNotIn("private-marker", path.read_text())
        run.assert_not_called()
        binary.assert_not_called()
        notify.assert_not_called()

    def test_wrong_local_os_does_not_fetch_random_pool(self):
        import subscription_pool

        with patch.dict(os.environ, {"CHECKIN_CONFIG": json.dumps(configuration())}, clear=True), \
                patch.object(app.platform, "system", return_value="Linux"), \
                patch.object(subscription_pool, "load_pool") as load, \
                patch.object(app, "send_notifications"), self.assertRaises(SystemExit):
            app.main()
        load.assert_not_called()

    def test_ip_failure_skips_candidate_and_preserves_successful_observation(self):
        import account_observations

        candidates = [{"server": "http://127.0.0.1:18080"}, {"server": "http://127.0.0.1:18081"}]
        observations = {}
        with patch.object(app, "browser_login_complete", return_value=({"quota": 500000}, "SUCCESS")), \
                patch.object(account_observations, "query_country", return_value={
                    "name": "US", "code": "US", "timezone_id": "America/New_York"}), \
                patch.object(account_observations, "query_exit_ip", side_effect=[None, "8.8.8.8"]) as probe:
            result = app.checkin_assigned_account({"id": "a01"}, candidates, {}, observations=observations)
        self.assertEqual(result, ({"quota": 500000}, "SUCCESS"))
        self.assertEqual(observations, {"exit_ip": "8.8.8.8", "country": {"name": "US", "code": "US"},
                                       "timezone_id": "America/New_York"})
        self.assertEqual([call.args[0] for call in probe.call_args_list], candidates)


class NotificationDetailTests(unittest.TestCase):
    def test_notify_persists_partial_success_and_compares_next_run_without_subscription_fetch(self):
        import subscription_pool
        import account_observations

        config = routing.parse_config(json.dumps(configuration()))
        groups = routing.build_manifest(config["accounts"])["groups"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = root / "nested" / "history.json"
            github_env = root / "env"
            for group in groups:
                path = root / f"checkin-results-{group['group_id']}" / "result.json"
                path.parent.mkdir()
                rows = [{"id": i, "quota": 500000 if i == "a01" else None,
                         "stage": "SUCCESS" if i == "a01" else "FORM_NOT_FOUND", "exit_ip": "203.0.113.10"}
                        for i in group["account_ids"]]
                report.write_report(path, group, rows)
            env = {"CHECKIN_CONFIG": json.dumps(configuration()), "CHECKIN_MODE": "isolated", "PREPARE_RESULT": "success",
                   "BALANCE_HISTORY_PATH": str(history), "GITHUB_ENV": str(github_env)}
            with patch.dict(os.environ, env, clear=True), patch.object(subscription_pool, "load_pool") as load, \
                    patch.object(app, "send_notifications") as notify:
                self.assertEqual(report._notify(root / "missing.json", root), 1)
                self.assertEqual(len(account_observations.load_history(history)["balances"]), 1)
                self.assertIn("BALANCE_HISTORY_READY=true", github_env.read_text())
                first = notify.call_args.args[1]
                self.assertIn("上次余额：未知", first)
                for group in groups:
                    path = root / f"checkin-results-{group['group_id']}" / "result.json"
                    report.write_report(path, group, [{"id": i, "quota": 1000000, "stage": "SUCCESS", "exit_ip": None}
                                                     for i in group["account_ids"]])
                self.assertEqual(report._notify(root / "missing.json", root), 0)
                second = notify.call_args.args[1]
                self.assertIn("上次余额：1.00$", second)
                self.assertIn("余额变化：+1.00$", second)
                self.assertIn("当前余额：2.00$", second)
            self.assertNotIn("dummy-secret", history.read_text())
            self.assertNotIn("example.test", history.read_text())
            self.assertNotIn("203.0.113.10", history.read_text())
        load.assert_not_called()

    def test_history_storage_failure_does_not_lose_valid_results(self):
        import account_observations

        config = routing.parse_config(json.dumps(configuration()))
        rows = [("windows-2022 a01", {"quota": 500000, "exit_ip": None}, "SUCCESS")]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(account_observations, "save_history", return_value=False), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            enriched = report.observe_balances(rows, config, Path(directory) / "history.json")
        self.assertEqual(enriched[0][1]["quota"], 500000)
        self.assertEqual(enriched[0][2], "SUCCESS")
        self.assertEqual(errors.getvalue().strip(), "HISTORY_SAVE_FAIL")

    def test_optional_ip_reports_validate_and_old_reports_remain_supported(self):
        group = {"group_id": "g01", "os": "windows-2022", "account_ids": ["a01"], "mode": "isolated"}
        row = {"id": "a01", "quota": 500000, "stage": "SUCCESS", "exit_ip": "203.0.113.10"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "checkin-results-g01" / "result.json"
            path.parent.mkdir()
            report.write_report(path, group, [row])
            detailed = report.combine_reports({"version": 1, "groups": [group]}, root, details=True)
            self.assertEqual(detailed, [("windows-2022 a01", {
                "quota": 500000, "balance": "1.00$", "exit_ip": "203.0.113.10"}, "SUCCESS")])
            for invalid in ("private-marker", "203.0.113.10\nsecret", True, "http://203.0.113.10", "fe80::1%eth0"):
                with self.subTest(ip=invalid), self.assertRaisesRegex(ValueError, "^REPORT_INVALID$"):
                    report.write_report(path, group, [dict(row, exit_ip=invalid)])
            report.write_report(path, group, [{k: v for k, v in row.items() if k != "exit_ip"}])
            self.assertEqual(report.combine_reports({"version": 1, "groups": [group]}, root),
                             [("windows-2022 a01", "1.00$", "SUCCESS")])

    def test_formatter_displays_historical_net_change_and_unknowns_not_reward(self):
        rows = [("windows-2022 a01", {"quota": 5500000, "previous_quota": 5000000,
                 "exit_ip": "203.0.113.10"}, "SUCCESS"),
                ("macos-15 a02", {"quota": None, "previous_quota": None, "exit_ip": None}, "FORM_NOT_FOUND")]
        html_message, plain = app.format_notifications(rows, 1, 2)
        for text in (html_message, plain):
            for marker in ("10.00$", "+1.00$", "11.00$", "203.0.113.10", "FORM_NOT_FOUND"):
                self.assertIn(marker, text)
            self.assertNotIn("签到奖励", text)
            self.assertIn("未获取", text)
        _, negative = app.format_notifications([("a03", {"quota": 0, "previous_quota": 500000,
                                                "exit_ip": "2001:db8::1"}, "SUCCESS")], 1, 1)
        self.assertIn("-1.00$", negative)
        self.assertIn("0.00$", negative)


if __name__ == "__main__":
    unittest.main()
