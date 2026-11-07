import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import account_observations as observations
import app
import report


ACCOUNT = {"id": "a01", "site": "https://example.test", "username": "dummy-user", "os": "windows"}
CONFIG = {"accounts": [ACCOUNT], "notifications": {}}
GROUP = {"group_id": "g01", "os": "windows-2022", "account_ids": ["a01"], "mode": "isolated"}


class BalanceReliabilityTests(unittest.TestCase):
    def test_history_read_explains_missing_invalid_and_restored_baselines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "balances.json"
            self.assertEqual(observations.load_history(path, with_status=True),
                             ({"version": 1, "balances": {}}, "MISSING"))
            path.write_text("not-json", encoding="utf-8")
            self.assertEqual(observations.load_history(path, with_status=True)[1], "INVALID")
            self.assertTrue(observations.save_history(path, {"version": 1, "balances": {}}))
            self.assertEqual(observations.load_history(path, with_status=True)[1], "RESTORED")

    def test_independent_next_run_restores_persisted_balance_and_exact_delta(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_path, second_path = root / "run1" / "balances.json", root / "run2" / "balances.json"
            with patch.dict(os.environ, {}, clear=True):
                first = report.observe_balances([("windows-2022 a01", {"quota": 90615000}, "SUCCESS")], CONFIG, first_path)
                self.assertEqual(first[0][1]["history_status"], "MISSING")
                self.assertTrue(first[0][1]["history_saved"])
                second_path.parent.mkdir()
                shutil.copyfile(first_path, second_path)
                second = report.observe_balances([("windows-2022 a01", {"quota": 90715000}, "SUCCESS")], CONFIG, second_path)
            self.assertEqual(second[0][1]["previous_quota"], 90615000)
            self.assertEqual(second[0][1]["history_status"], "AVAILABLE")
            for message in app.format_notifications(second, 1, 1):
                self.assertIn("181.23$", message)
                self.assertIn("+0.20$", message)
                self.assertIn("181.43$", message)

    def test_failed_persistence_is_visible_but_does_not_claim_login_failed(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(observations, "save_history", return_value=False), \
                contextlib.redirect_stderr(io.StringIO()):
            rows = report.observe_balances([("windows-2022 a01", {"quota": 500000}, "SUCCESS")],
                                           CONFIG, Path(directory) / "balances.json")
        self.assertFalse(rows[0][1]["history_saved"])
        for message in app.format_notifications(rows, 1, 1):
            self.assertIn("HISTORY_SAVE_FAIL", message)
            self.assertIn("登录成功", message)

    def test_successful_login_without_balance_keeps_previous_baseline(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / "balances.json"
            report.observe_balances([("windows-2022 a01", {"quota": 500000}, "SUCCESS")], CONFIG, path)
            before = observations.load_history(path)
            rows = report.observe_balances([("windows-2022 a01", {"quota": None}, "SUCCESS")], CONFIG, path)
            self.assertEqual(observations.load_history(path), before)
            self.assertEqual(rows[0][1]["previous_quota"], 500000)
            self.assertIsNone(rows[0][1]["quota"])

    def test_success_without_balance_survives_safe_report_and_final_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "checkin-results-g01" / "result.json"
            path.parent.mkdir()
            report.write_report(path, GROUP, [{"id": "a01", "quota": None, "stage": "SUCCESS"}])
            rows = report.combine_reports({"version": 1, "groups": [GROUP]}, root, details=True)
        self.assertEqual(rows[0][2], "SUCCESS")
        self.assertIsNone(rows[0][1]["quota"])
        for message in app.format_notifications(rows, 1, 1):
            self.assertIn("登录成功", message)
            self.assertIn("当前余额：未获取", message)
            self.assertNotIn("余额 N/A", message)

    def test_corrupt_or_absent_cache_never_fabricates_zero_previous_balance(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / "balances.json"
            path.write_text("bad-json", encoding="utf-8")
            rows = report.observe_balances([("windows-2022 a01", {"quota": 500000}, "SUCCESS")], CONFIG, path)
        self.assertIsNone(rows[0][1]["previous_quota"])
        self.assertEqual(rows[0][1]["history_status"], "INVALID")
        for message in app.format_notifications(rows, 1, 1):
            self.assertIn("HISTORY_INVALID", message)
            self.assertIn("余额变化：未知", message)

    def test_unreadable_previous_history_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / "balances.json"
            path.write_text("private-existing-data", encoding="utf-8")
            with patch.object(Path, "open", side_effect=PermissionError("private-error")), \
                    patch.object(observations, "save_history") as save:
                rows = report.observe_balances([("windows-2022 a01", {"quota": 500000}, "SUCCESS")], CONFIG, path)
            self.assertEqual(path.read_text(encoding="utf-8"), "private-existing-data")
        save.assert_not_called()
        self.assertEqual(rows[0][1]["history_status"], "READ_FAILED")
        self.assertFalse(rows[0][1]["history_saved"])

    def test_failed_actions_readiness_export_is_visible_as_unsaved_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict(os.environ, {"GITHUB_ENV": str(root / "absent" / "env")}, clear=True), \
                    contextlib.redirect_stderr(io.StringIO()):
                rows = report.observe_balances([("windows-2022 a01", {"quota": 500000}, "SUCCESS")],
                                               CONFIG, root / "balances.json")
        self.assertFalse(rows[0][1]["history_saved"])


if __name__ == "__main__":
    unittest.main()
