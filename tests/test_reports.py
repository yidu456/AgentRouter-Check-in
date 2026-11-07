import contextlib
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import report
import routing


ROOT = Path(__file__).resolve().parents[1]


def group(group_id="g01", os_name="ubuntu-24.04", account_ids=None, mode="isolated"):
    return {
        "group_id": group_id,
        "os": os_name,
        "account_ids": ["a01"] if account_ids is None else account_ids,
        "mode": mode,
    }


def manifest(groups=None):
    return {"version": 1, "groups": groups or [group()]}


def result(account_id="a01", quota=500000, stage="SUCCESS"):
    return {"id": account_id, "quota": quota, "stage": stage}


def details(quota=None):
    return {"quota": quota, "balance": f"{quota / 500000:.2f}$" if quota is not None else None,
            "exit_ip": None, "previous_quota": None, "country": None}


def write_raw_report(root, value, group_id="g01"):
    path = Path(root) / f"checkin-results-{group_id}" / "result.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


class WriteReportTests(unittest.TestCase):
    def test_writes_only_the_safe_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            report.write_report(path, group(), [result()])

            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8")),
                {
                    "version": 1,
                    "group_id": "g01",
                    "os": "ubuntu-24.04",
                    "results": [{"id": "a01", "quota": 500000, "stage": "SUCCESS"}],
                },
            )
            self.assertFalse(path.with_name("result.json.tmp").exists())

    def test_macos_15_report_preserves_native_runner_label(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            report.write_report(path, group(os_name="macos-15"), [result()])
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["os"], "macos-15")

    def test_retired_macos_label_cannot_write_a_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            with self.assertRaisesRegex(ValueError, r"^REPORT_INVALID$"):
                report.write_report(path, group(os_name="macos-14"), [result()])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_rejects_invalid_quota_and_stage_combinations(self):
        invalid_rows = [
            [result(quota=-1)],
            [result(quota=True)],
            [result(quota=1.5)],
            [result(quota=math.nan)],
            [result(quota=1, stage="WAF_TIMEOUT")],
            [result(quota=None, stage=[])],
            [result(quota=None, stage="exception: credential-marker")],
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            for rows in invalid_rows:
                with self.subTest(rows=rows):
                    with self.assertRaisesRegex(ValueError, r"^REPORT_INVALID$"):
                        report.write_report(path, group(), rows)

    def test_accepts_every_safe_failure_stage_with_null_quota(self):
        failure_stages = {
            "UNKNOWN",
            "GOTO_TIMEOUT",
            "WAF_TIMEOUT",
            "FORM_NOT_FOUND",
            "FORM_OPERATE_TIMEOUT",
            "USER_API_FAIL",
            "API_PAYLOAD_FAIL",
            "QUOTA_INVALID",
            "PAGE_TIMEOUT",
            "BROWSER_LAUNCH_FAIL",
            "UNEXPECTED",
            "NO_PROXY",
            "PROXY_LIST_EXHAUSTED",
            "UNFINISHED",
            "ROUTE_CONFIG_FAIL",
            "NODE_MISSING",
            "NODE_CONFIG_FAIL",
            "NODE_UNREACHABLE",
            "PROXY_START_FAIL",
            "JOB_MISSING",
            "REPORT_INVALID",
            "PREPARE_FAIL",
        }
        with tempfile.TemporaryDirectory() as directory:
            for stage in failure_stages:
                with self.subTest(stage=stage):
                    path = Path(directory) / f"{stage}.json"
                    report.write_report(path, group(), [result(quota=None, stage=stage)])

    def test_rejects_unknown_fields_duplicate_or_incomplete_ids(self):
        cases = [
            [dict(result(), secret="credential-marker")],
            [result(), result()],
            [result("outside")],
            [result("a01")],
        ]
        groups = [group(), group(), group(), group(account_ids=["a01", "a02"])]
        with tempfile.TemporaryDirectory() as directory:
            for manifest_group, rows in zip(groups, cases):
                with self.subTest(rows=rows):
                    with self.assertRaisesRegex(ValueError, r"^REPORT_INVALID$"):
                        report.write_report(Path(directory) / "result.json", manifest_group, rows)

    def test_failed_atomic_replace_preserves_old_report_and_removes_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            path.write_text("old-safe-report", encoding="utf-8")

            with patch("report.os.replace", side_effect=OSError("credential-marker")):
                with self.assertRaises(OSError):
                    report.write_report(path, group(), [result()])

            self.assertEqual(path.read_text(encoding="utf-8"), "old-safe-report")
            self.assertFalse(path.with_name("result.json.tmp").exists())


class CombineReportTests(unittest.TestCase):
    def test_combines_expected_paths_in_manifest_order_and_formats_quota(self):
        public_manifest = manifest(
            [
                group("g01", "ubuntu-24.04", ["a01", "a02"]),
                group("g02", "windows-2022", ["b01"]),
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            write_raw_report(
                directory,
                {
                    "version": 1,
                    "group_id": "g01",
                    "os": "ubuntu-24.04",
                    "results": [result("a01", 500000), result("a02", None, "WAF_TIMEOUT")],
                },
            )
            write_raw_report(
                directory,
                {
                    "version": 1,
                    "group_id": "g02",
                    "os": "windows-2022",
                    "results": [result("b01", 0)],
                },
                "g02",
            )
            rows = report.combine_reports(public_manifest, Path(directory))

        self.assertEqual(
            rows,
            [
                ("ubuntu-24.04 a01", "1.00$", "SUCCESS"),
                ("ubuntu-24.04 a02", None, "WAF_TIMEOUT"),
                ("windows-2022 b01", "0.00$", "SUCCESS"),
            ],
        )

    def test_missing_group_is_not_silently_successful_or_found_by_globbing(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "result.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "group_id": "g01",
                        "os": "ubuntu-24.04",
                        "results": [result()],
                    }
                ),
                encoding="utf-8",
            )
            rows = report.combine_reports(
                manifest([group(account_ids=["a01", "a02"])]), Path(directory)
            )

        self.assertEqual(
            rows,
            [
                ("ubuntu-24.04 a01", None, "JOB_MISSING"),
                ("ubuntu-24.04 a02", None, "JOB_MISSING"),
            ],
        )

    def test_any_invalid_report_invalidates_the_entire_group_without_leaking_fields(self):
        valid_base = {
            "version": 1,
            "group_id": "g01",
            "os": "ubuntu-24.04",
            "results": [result("a01"), result("a02", None, "WAF_TIMEOUT")],
        }
        invalid_reports = [
            "not-json credential-marker",
            dict(valid_base, version=True),
            dict(valid_base, group_id="g02"),
            dict(valid_base, os="macos-15"),
            dict(valid_base, secret="credential-marker"),
            dict(valid_base, results=[result("a01"), result("a01")]),
            dict(valid_base, results=[result("a01"), result("outside")]),
            dict(valid_base, results=[result("a01")]),
            dict(valid_base, results=[dict(result("a01"), secret="credential-marker"), result("a02", None, "WAF_TIMEOUT")]),
            dict(valid_base, results=[result("a01", True), result("a02", None, "WAF_TIMEOUT")]),
            dict(valid_base, results=[result("a01"), result("a02", 1, "WAF_TIMEOUT")]),
        ]
        expected = [
            ("ubuntu-24.04 a01", None, "REPORT_INVALID"),
            ("ubuntu-24.04 a02", None, "REPORT_INVALID"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkin-results-g01" / "result.json"
            path.parent.mkdir()
            for value in invalid_reports:
                with self.subTest(value=value):
                    if isinstance(value, str):
                        path.write_text(value, encoding="utf-8")
                    else:
                        path.write_text(json.dumps(value), encoding="utf-8")
                    stderr = io.StringIO()
                    with contextlib.redirect_stderr(stderr):
                        rows = report.combine_reports(
                            manifest([group(account_ids=["a01", "a02"])]), Path(directory)
                        )
                    self.assertEqual(rows, expected)
                    self.assertNotIn("credential-marker", stderr.getvalue() + repr(rows))

    def test_duplicate_json_keys_in_report_invalidate_the_entire_group(self):
        source = (
            '{"version":1,"version":1,"group_id":"g01","os":"ubuntu-24.04",'
            '"results":[{"id":"a01","quota":500000,"stage":"SUCCESS"}]}'
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkin-results-g01" / "result.json"
            path.parent.mkdir()
            path.write_text(source, encoding="utf-8")

            rows = report.combine_reports(manifest(), Path(directory))

        self.assertEqual(rows, [("ubuntu-24.04 a01", None, "REPORT_INVALID")])


class ManifestValidationTests(unittest.TestCase):
    def assert_manifest_fails(self, value):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, r"^REPORT_INVALID$"):
                report.combine_reports(value, Path(directory))

    def test_manifest_rejects_unknown_shapes_ids_runners_and_duplicates(self):
        cases = [
            {"version": 1, "groups": [], "secret": "credential-marker"},
            {"version": True, "groups": []},
            {"version": 1, "groups": "bad"},
            manifest([dict(group(), secret="credential-marker")]),
            manifest([group(group_id="../escape")]),
            manifest([group(os_name="ubuntu-latest")]),
            manifest([group(os_name=[])]),
            manifest([group(account_ids=[])]),
            manifest([group(account_ids=["a", "b", "c", "d"])]),
            manifest([group(account_ids=["a", "a"])]),
            manifest([group(account_ids=["1bad"])]),
            manifest([group(mode="other")]),
            manifest([group(os_name="windows-2022", mode="legacy")]),
            manifest(
                [
                    group("g01", account_ids=["legacy001"], mode="legacy"),
                    group("g02", account_ids=["legacy002"], mode="legacy"),
                ]
            ),
            manifest(
                [
                    group("g01", account_ids=["legacy001"], mode="legacy"),
                    group("g02", "macos-15", ["a01"], mode="isolated"),
                ]
            ),
            manifest([group("g01"), group("g01", "windows-2022", ["b01"])]),
            manifest([group("g01", account_ids=["a01"]), group("g02", "macos-15", ["a01"])]),
        ]
        for value in cases:
            with self.subTest(value=value):
                self.assert_manifest_fails(value)

    def test_manifest_allows_legacy_ids_and_rejects_more_than_256_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            rows = report.combine_reports(
                manifest([group(account_ids=["legacy001"], mode="legacy")]), Path(directory)
            )
        self.assertEqual(rows[0][2], "JOB_MISSING")

        too_many = manifest(
            [group(f"g{i:03}", account_ids=[f"a{i:03}"]) for i in range(257)]
        )
        self.assert_manifest_fails(too_many)

    def test_legacy_manifest_keeps_any_account_count_in_one_ubuntu_group(self):
        account_ids = [f"legacy{i:03}" for i in range(1, 6)]
        with tempfile.TemporaryDirectory() as directory:
            rows = report.combine_reports(
                manifest([group(account_ids=account_ids, mode="legacy")]), Path(directory)
            )

        self.assertEqual([row[0] for row in rows], [f"ubuntu-24.04 {item}" for item in account_ids])
        self.assertTrue(all(row[2] == "JOB_MISSING" for row in rows))


class NotifyCliTests(unittest.TestCase):
    def setUp(self):
        self.app_calls = []

        def format_balance(quota):
            return f"{quota / 500000:.2f}$"

        def format_notifications(rows, success_count, total):
            self.app_calls.append(("format", rows, success_count, total))
            return "html-summary", "plain-summary"

        def send_notifications(html, plain, config=None, wecom_markdown=False):
            self.assertEqual(wecom_markdown, config is not None)
            self.app_calls.append(("send", html, plain, config))
            return {"telegram": True, "wecom": None}

        self.fake_app = types.SimpleNamespace(
            format_balance=format_balance,
            format_notifications=format_notifications,
            send_notifications=send_notifications,
        )
        self.fake_routing = types.SimpleNamespace(
            parse_config=routing.parse_config,
            build_manifest=routing.build_manifest,
            RUNNERS=routing.RUNNERS,
        )

    def run_notify(self, public_manifest, report_value=None, env=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            if public_manifest is not None:
                manifest_path.write_text(public_manifest if isinstance(public_manifest, str)
                                         else json.dumps(public_manifest), encoding="utf-8")
            if report_value is not None:
                values = report_value if isinstance(report_value, list) else [report_value]
                for value in values:
                    write_raw_report(root, value, value["group_id"])
            expected = public_manifest if isinstance(public_manifest, dict) else manifest()
            os_keys = {"ubuntu-24.04": "ubuntu", "windows-2022": "windows", "macos-15": "macos"}
            config = {"version": 1, "notifications": {"telegram": {"bot_token": "token", "chat_id": "chat"}},
                      "accounts": [{"id": account_id, "username": account_id + "@example.test",
                                    "password": "credential-marker", "os": os_keys[g["os"]],
                                    "proxies": [{"link": f"socks5://{account_id}.example:1080"}]}
                                   for g in expected["groups"] for account_id in g["account_ids"]]}
            environment = {
                "PREPARE_RESULT": "success",
                "CHECKIN_CONFIG": json.dumps(config),
                "CHECKIN_MODE": "isolated",
            }
            if env:
                for key, value in env.items():
                    if value is None:
                        environment.pop(key, None)
                    else:
                        environment[key] = value
            stderr = io.StringIO()
            with patch.dict(os.environ, environment, clear=True), patch.dict(
                "sys.modules", {"app": self.fake_app, "routing": self.fake_routing}
            ), contextlib.redirect_stderr(stderr):
                code = report.main(
                    ["notify", "--manifest", str(manifest_path), "--reports-dir", str(root)]
                )
            return code, stderr.getvalue()

    def test_new_mode_recovers_missing_corrupt_and_mismatched_manifest_from_complete_config(self):
        config = {"version": 1, "notifications": {"telegram": {"bot_token": "token", "chat_id": "chat"}},
                  "accounts": [{"id": "a01", "username": "one@example.test", "password": "credential-marker",
                                "os": "ubuntu", "proxies": [{"link": "socks5://proxy.example:1080"}]}]}
        value = {"version": 1, "group_id": "g01", "os": "ubuntu-24.04", "results": [result()]}
        for public in (None, "{credential-marker", manifest([group(account_ids=["phantom"])])):
            with self.subTest(public=public):
                self.app_calls.clear()
                code, stderr = self.run_notify(public, value, {"CHECKIN_CONFIG": json.dumps(config)})
                self.assertEqual(code, 0, stderr)
                self.assertEqual(self.app_calls[0], ("format", [("ubuntu-24.04 a01", details(500000), "SUCCESS")], 1, 1))
                self.assertEqual([call[0] for call in self.app_calls].count("send"), 1)
                self.assertNotIn("credential-marker", stderr + repr(self.app_calls))

    def test_new_mode_recovers_expected_missing_accounts_without_manifest(self):
        code, stderr = self.run_notify(None)
        self.assertEqual(code, 1, stderr)
        self.assertEqual(len(self.app_calls), 2)
        self.assertEqual(self.app_calls[0], ("format", [("ubuntu-24.04 a01", details(), "JOB_MISSING")], 0, 1))
        self.assertEqual([call[0] for call in self.app_calls].count("send"), 1)

    def test_legacy_missing_or_corrupt_manifest_still_sends_safe_final_failure(self):
        for public in (None, "{credential-marker"):
            with self.subTest(public=public):
                self.app_calls.clear()
                code, stderr = self.run_notify(public, env={"CHECKIN_MODE": "legacy", "CHECKIN_CONFIG": ""})
                self.assertEqual(code, 1)
                self.assertEqual(len(self.app_calls), 2)
                self.assertEqual(self.app_calls[0], ("format", [("Manifest", None, "REPORT_INVALID")], 0, 1))
                self.assertEqual([call[0] for call in self.app_calls].count("send"), 1)
                self.assertIsNone(self.app_calls[-1][3])
                self.assertNotIn("credential-marker", stderr + repr(self.app_calls))

    def test_success_uses_validated_new_notification_config(self):
        value = {
            "version": 1,
            "group_id": "g01",
            "os": "ubuntu-24.04",
            "results": [result()],
        }
        code, stderr = self.run_notify(manifest(), value)

        self.assertEqual(code, 0, stderr)
        self.assertEqual(self.app_calls[0][0], "format")
        self.assertEqual(self.app_calls[0][2:], (1, 1))
        self.assertEqual(
            self.app_calls[1],
            (
                "send",
                "html-summary",
                "plain-summary",
                {"telegram": {"bot_token": "token", "chat_id": "chat"}},
            ),
        )

    def test_account_failure_sets_exit_one_but_still_notifies(self):
        code, stderr = self.run_notify(manifest(), None)

        self.assertEqual(code, 1, stderr)
        self.assertEqual(self.app_calls[0][2:], (0, 1))
        self.assertEqual(self.app_calls[1][0], "send")

    def test_quota_format_failure_invalidates_only_its_group_and_still_notifies(self):
        public_manifest = manifest(
            [
                group("g01", "ubuntu-24.04", ["a01", "a02"]),
                group("g02", "macos-15", ["b01"]),
            ]
        )
        report_values = [
            {
                "version": 1,
                "group_id": "g01",
                "os": "ubuntu-24.04",
                "results": [result("a01", 10**400), result("a02", 500000)],
            },
            {
                "version": 1,
                "group_id": "g02",
                "os": "macos-15",
                "results": [result("b01", 0)],
            },
        ]

        def format_balance(quota):
            if quota == 10**400:
                raise OverflowError("credential-marker")
            return f"{quota / 500000:.2f}$"

        self.fake_app.format_balance = format_balance
        code, stderr = self.run_notify(public_manifest, report_values)

        self.assertEqual(code, 1)
        self.assertEqual(
            self.app_calls[0],
            (
                "format",
                [
                    ("ubuntu-24.04 a01", details(), "REPORT_INVALID"),
                    ("ubuntu-24.04 a02", details(), "REPORT_INVALID"),
                    ("macos-15 b01", details(0), "SUCCESS"),
                ],
                1,
                3,
            ),
        )
        self.assertEqual([call[0] for call in self.app_calls].count("send"), 1)
        self.assertNotIn("credential-marker", stderr)

    def test_legacy_mode_never_merges_new_notification_config(self):
        code, stderr = self.run_notify(
            manifest([group(account_ids=["legacy001"], mode="legacy")]),
            None,
            {"CHECKIN_MODE": "legacy", "CHECKIN_CONFIG": ""},
        )

        self.assertEqual(code, 1, stderr)
        self.assertIsNone(self.app_calls[-1][3])

    def test_explicit_legacy_mode_rejects_nonempty_new_config_without_sending(self):
        code, stderr = self.run_notify(
            manifest([group(account_ids=["legacy001"], mode="legacy")]),
            None,
            {"CHECKIN_MODE": "legacy", "CHECKIN_CONFIG": "credential-marker"},
        )

        self.assertEqual(code, 1)
        self.assertEqual(self.app_calls, [])
        self.assertNotIn("credential-marker", stderr)

    def test_present_blank_config_requires_explicit_legacy_mode(self):
        code, stderr = self.run_notify(
            manifest([group(account_ids=["legacy001"], mode="legacy")]),
            None,
            {"CHECKIN_MODE": "", "CHECKIN_CONFIG": ""},
        )

        self.assertEqual(code, 1)
        self.assertEqual(self.app_calls, [])
        self.assertNotIn("credential-marker", stderr)

    def test_prepare_failure_sends_only_generic_failure_from_fully_valid_new_config(self):
        code, stderr = self.run_notify(
            None,
            env={"PREPARE_RESULT": "failure"},
        )

        self.assertEqual(code, 1, stderr)
        self.assertEqual(
            self.app_calls[0],
            ("format", [("Prepare", None, "PREPARE_FAIL")], 0, 1),
        )
        self.assertEqual(self.app_calls[1][0], "send")

    def test_prepare_failure_with_invalid_config_does_not_call_bot_or_leak_error(self):
        self.fake_routing.parse_config = lambda raw: (_ for _ in ()).throw(
            ValueError("credential-marker")
        )
        code, stderr = self.run_notify(
            None,
            env={"PREPARE_RESULT": "failure", "CHECKIN_CONFIG": "credential-marker"},
        )

        self.assertEqual(code, 1)
        self.assertEqual(self.app_calls, [])
        self.assertNotIn("credential-marker", stderr)

    def test_notification_transport_exception_does_not_change_account_outcome_or_leak(self):
        self.fake_app.send_notifications = lambda *args, **kwargs: (_ for _ in ()).throw(
            RuntimeError("credential-marker")
        )
        value = {
            "version": 1,
            "group_id": "g01",
            "os": "ubuntu-24.04",
            "results": [result()],
        }
        code, stderr = self.run_notify(manifest(), value)

        self.assertEqual(code, 0)
        self.assertNotIn("credential-marker", stderr)

    def test_notification_format_exception_does_not_leak_or_change_account_outcome(self):
        self.fake_app.format_notifications = lambda *args: (_ for _ in ()).throw(
            RuntimeError("credential-marker")
        )
        value = {
            "version": 1,
            "group_id": "g01",
            "os": "ubuntu-24.04",
            "results": [result()],
        }
        code, stderr = self.run_notify(manifest(), value)

        self.assertEqual(code, 0)
        self.assertNotIn("credential-marker", stderr)


class NotifyCliIntegrationTests(unittest.TestCase):
    def test_real_config_and_format_helpers_complete_without_configured_channels(self):
        secret = "credential-marker"
        public_manifest = manifest()
        report_value = {
            "version": 1,
            "group_id": "g01",
            "os": "ubuntu-24.04",
            "results": [result()],
        }
        config = {
            "version": 1,
            "notifications": {},
            "accounts": [
                {
                    "id": "a01",
                    "username": "unit@example.com",
                    "password": secret,
                    "os": "ubuntu",
                    "proxies": [{"link": "socks5://proxy.example:1080"}],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(public_manifest), encoding="utf-8")
            write_raw_report(root, report_value)
            environment = os.environ.copy()
            environment.update(
                {
                    "PREPARE_RESULT": "success",
                    "CHECKIN_MODE": "isolated",
                    "CHECKIN_CONFIG": json.dumps(config),
                }
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    "report.py",
                    "notify",
                    "--manifest",
                    str(manifest_path),
                    "--reports-dir",
                    str(root),
                ],
                cwd=ROOT,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(secret, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
