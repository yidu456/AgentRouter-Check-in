import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_MANIFEST = {"version": 1, "groups": [
    {"group_id": "g01", "os": "windows-2022", "account_ids": ["account_alpha", "account_beta"], "mode": "isolated"},
    {"group_id": "g02", "os": "macos-14", "account_ids": ["account_gamma"], "mode": "isolated"},
]}


class PlanningCliTests(unittest.TestCase):
    def run_cli(self, command, value=PUBLIC_MANIFEST, extra=(), github_env=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "manifest.json"
            source.write_text(value if isinstance(value, str) else json.dumps(value), encoding="utf-8")
            output, assignment = root / "output", root / "assignment"
            env = os.environ.copy()
            for name in ("CHECKIN_CONFIG", "ACCOUNTS", "USERNAME", "PASSWORD", "GITHUB_OUTPUT", "GITHUB_ENV"):
                env.pop(name, None)
            env.update(CHECKIN_CONFIG="invalid-secret-marker", USERNAME="account_alpha",
                       PASSWORD="credential-marker", GITHUB_OUTPUT=str(output))
            if github_env:
                env["GITHUB_ENV"] = str(assignment)
            result = subprocess.run([sys.executable, "routing.py", command, "--manifest", str(source), *extra],
                                    cwd=ROOT, env=env, text=True, capture_output=True)
            return result, (output.read_text(encoding="utf-8") if output.exists() else ""), \
                (assignment.read_text(encoding="utf-8") if assignment.exists() else "")

    def test_matrix_uses_only_os_and_numeric_slots_without_reading_credentials(self):
        result, output, assignment = self.run_cli("matrix")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.removeprefix("matrix=").strip()), {"include": [
            {"os": "windows-2022", "slot": 1}, {"os": "macos-14", "slot": 2},
        ]})
        self.assertEqual(assignment, "")
        for marker in ("account_alpha", "account_beta", "account_gamma", "credential-marker", "invalid-secret-marker"):
            self.assertNotIn(marker, result.stdout + result.stderr + output)

    def test_assignment_is_job_local_and_preserves_exact_group_ids_and_order(self):
        result, output, assignment = self.run_cli("assign", extra=("--slot", "1", "--runner", "windows-2022"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "")
        self.assertEqual(dict(line.split("=", 1) for line in assignment.splitlines()), {
            "GROUP_ID": "g01", "CHECKIN_MODE": "isolated", "RUNNER_KEY": "windows-2022",
            "ACCOUNT_IDS": '["account_alpha","account_beta"]',
        })
        self.assertNotIn("credential-marker", assignment + result.stdout + result.stderr)

    def test_assign_handles_mac_and_legacy_without_losing_account_count(self):
        cases = [
            (PUBLIC_MANIFEST, "2", "macos-14", "g02", "isolated", ["account_gamma"]),
            ({"version": 1, "groups": [{"group_id": "g01", "os": "ubuntu-24.04", "mode": "legacy",
                                        "account_ids": ["legacy001", "legacy002", "legacy003", "legacy004"]}]},
             "1", "ubuntu-24.04", "g01", "legacy", ["legacy001", "legacy002", "legacy003", "legacy004"]),
        ]
        for value, slot, runner, group_id, mode, ids in cases:
            with self.subTest(runner=runner):
                result, output, assignment = self.run_cli("assign", value, ("--slot", slot, "--runner", runner))
                self.assertEqual(result.returncode, 0, result.stderr)
                values = dict(line.split("=", 1) for line in assignment.splitlines())
                self.assertEqual((values["GROUP_ID"], values["CHECKIN_MODE"], json.loads(values["ACCOUNT_IDS"])),
                                 (group_id, mode, ids))
                self.assertEqual(output, "")

    def test_invalid_manifest_is_rejected_before_any_public_output(self):
        invalid = ["{credential-marker", dict(PUBLIC_MANIFEST, secret="credential-marker"),
                   {"version": 1, "groups": []},
                   {"version": 1, "groups": [dict(PUBLIC_MANIFEST["groups"][0], os="not-a-runner")]},
                   {"version": 1, "groups": [dict(PUBLIC_MANIFEST["groups"][0], account_ids=["unsafe\nname"])]},
                   '{"version":1,"version":1,"groups":[]}']
        for value in invalid:
            for command in ("matrix", "assign"):
                with self.subTest(command=command, value=value):
                    extra = ("--slot", "1", "--runner", "windows-2022") if command == "assign" else ()
                    result, output, assignment = self.run_cli(command, value, extra)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual((output, assignment), ("", ""))
                    self.assertNotIn("credential-marker", result.stdout + result.stderr)

    def test_invalid_slot_runner_or_missing_env_fails_without_assigning_accounts(self):
        for slot, runner, has_env in (("0", "windows-2022", True), ("-1", "windows-2022", True),
                                      ("3", "windows-2022", True), ("1", "macos-14", True),
                                      ("1", "windows-2022", False)):
            with self.subTest(slot=slot, runner=runner, env=has_env):
                result, output, assignment = self.run_cli("assign", extra=("--slot", slot, "--runner", runner),
                                                          github_env=has_env)
                self.assertEqual(result.returncode, 1)
                self.assertEqual((output, assignment), ("", ""))

    def test_job_local_assignment_reaches_only_its_accounts_in_the_real_controller(self):
        result, _, assignment = self.run_cli("assign", extra=("--slot", "2", "--runner", "macos-14"))
        self.assertEqual(result.returncode, 0, result.stderr)
        env = dict(line.split("=", 1) for line in assignment.splitlines())
        accounts = []
        for group in PUBLIC_MANIFEST["groups"]:
            for account_id in group["account_ids"]:
                accounts.append({"id": account_id, "username": account_id, "password": "dummy-secret",
                                 "os": "windows" if group["os"] == "windows-2022" else "macos",
                                 "proxies": [{"link": f"socks5://{account_id}.example:1080"}]})
        env.update(CHECKIN_CONFIG=json.dumps({"version": 1, "accounts": accounts}), RESULT_PATH="unused-result.json")
        with patch.dict(os.environ, env, clear=True), patch.object(app.platform, "system", return_value="Darwin"), \
                patch.object(app, "run_isolated_group", return_value=0) as run, \
                patch.object(app, "send_notifications") as notify:
            with self.assertRaises(SystemExit) as exited:
                app.main()
            self.assertEqual(exited.exception.code, 0)
        self.assertEqual([account["id"] for account in run.call_args.args[0]], ["account_gamma"])
        self.assertEqual(run.call_args.args[1], {"group_id": "g02", "os": "macos-14",
                                               "account_ids": ["account_gamma"], "mode": "isolated"})
        notify.assert_not_called()


if __name__ == "__main__":
    unittest.main()
