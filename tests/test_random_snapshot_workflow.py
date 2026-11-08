import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app
import random_snapshot
import report
import routing
import subscription_pool

from test_random_snapshot import CONTEXT, PRIVATE


def configuration():
    groups = {}
    for system in ("ubuntu", "macos", "windows"):
        groups[system] = {"accounts": [
            {"id": f"{system}{index}", "username": f"{system}{index}@example.test", "password": PRIVATE,
             "proxies": [{"link": f"socks5://{system}{index}.example.test:1080"}, {"random": 1}]}
            for index in (1, 2)]}
    groups["ubuntu"]["accounts"][0]["proxies"][0] = {"node": "fixed-name"}
    return {"version": 2, "subscription_url": "https://subscription.example.test/sub", "groups": groups}


class RandomSnapshotWorkflowTests(unittest.TestCase):
    def setUp(self):
        for target in ("requests.get", "socket.create_connection", "proxy_runtime.subprocess.Popen",
                       "app.browser_login_complete", "app.send_notifications"):
            guard = patch(target, side_effect=AssertionError("external operation blocked"))
            guard.start()
            self.addCleanup(guard.stop)

    def prepare(self, manifest, env):
        response = Mock(status_code=200)
        response.iter_content.return_value = ["\n".join(
            f"socks5://pool{index}.example.test:1080" + ("#fixed-name" if index == 0 else "")
            for index in range(8)).encode()]
        with patch.dict(os.environ, env, clear=True), patch("requests.get", return_value=response) as get, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(routing.main(["prepare", "--manifest", str(manifest)]), 0)
        get.assert_called_once()

    def test_prepare_assign_all_os_workers_share_one_pool_without_refetch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, env_file = root / "manifest.json", root / "env"
            env = dict(CONTEXT, CHECKIN_CONFIG=json.dumps(configuration()), GITHUB_ENV=str(env_file))
            self.prepare(manifest, env)
            public = json.loads(manifest.read_text())
            report._validate_manifest(public)
            self.assertEqual(set(public), {"version", "groups", "random"})
            self.assertEqual(set(public["random"]), {"seed", "fingerprint"})
            self.assertEqual(env_file.read_text().strip(), "RANDOM_SNAPSHOT_READY=true")
            snapshot = root / random_snapshot.SNAPSHOT_NAME
            original_ciphertext = snapshot.read_bytes()
            selected = []
            for slot, group in enumerate(public["groups"], 1):
                with patch.dict(os.environ, env, clear=True):
                    routing._assign(manifest, slot, group["os"])
                values = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
                self.assertEqual(Path(values["RANDOM_SNAPSHOT_PATH"]), snapshot.resolve())
                system = {"ubuntu-24.04": "Linux", "macos-15": "Darwin", "windows-2022": "Windows"}[group["os"]]
                with patch.dict(os.environ, dict(env, **values, RESULT_PATH=str(root / "result.json")), clear=True), \
                        patch.object(app.platform, "system", return_value=system), \
                        patch.object(app, "run_isolated_group", return_value=0) as run, \
                        patch.object(subscription_pool, "load_pool", side_effect=AssertionError("refetch forbidden")) as load, \
                        self.assertRaises(SystemExit) as exited:
                    app.main()
                self.assertEqual(exited.exception.code, 0)
                load.assert_not_called()
                selected.extend(run.call_args.args[0])
                self.assertEqual(snapshot.read_bytes(), original_ciphertext)
            self.assertEqual(len(selected), 6)
            random_servers = [account["proxies"][1]["outbound"]["server"] for account in selected]
            self.assertEqual(len(set(random_servers)), 6)
            self.assertNotIn("pool0.example.test", random_servers)
            by_id = {account["id"]: account for account in selected}
            self.assertEqual(by_id["ubuntu1"]["proxies"][0], {"link": "socks5://pool0.example.test:1080#fixed-name"})
            self.assertTrue(all("link" in account["proxies"][0] for account in selected))
            self.assertNotIn(PRIVATE, manifest.read_text())
            self.assertNotIn("example.test", manifest.read_text())

    def test_missing_or_corrupted_snapshot_reports_failure_before_runtime(self):
        for issue in ("missing", "corrupt"):
            with self.subTest(issue=issue), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest, env_file = root / "manifest.json", root / "env"
                env = dict(CONTEXT, CHECKIN_CONFIG=json.dumps(configuration()), GITHUB_ENV=str(env_file))
                self.prepare(manifest, env)
                snapshot = root / random_snapshot.SNAPSHOT_NAME
                if issue == "missing":
                    snapshot.unlink()
                else:
                    snapshot.write_bytes(b"corrupted")
                with patch.dict(os.environ, env, clear=True):
                    routing._assign(manifest, 1, "ubuntu-24.04")
                values = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
                output = io.StringIO()
                with patch.dict(os.environ, dict(env, **values, RESULT_PATH=str(root / "result.json")), clear=True), \
                        patch.object(app.platform, "system", return_value="Linux"), \
                        patch.object(app, "run_isolated_group") as run, \
                        patch.object(subscription_pool, "load_pool") as load, contextlib.redirect_stdout(output), \
                        self.assertRaises(SystemExit) as exited:
                    app.main()
                self.assertEqual(exited.exception.code, 1)
                run.assert_not_called()
                load.assert_not_called()
                rows = json.loads((root / "result.json").read_text())["results"]
                self.assertEqual([row["stage"] for row in rows], ["RANDOM_POOL_FAIL"] * 2)
                reason = "SNAPSHOT_MISSING" if issue == "missing" else "SNAPSHOT_INVALID"
                self.assertIn("reason=" + reason, output.getvalue())
                self.assertNotIn(PRIVATE, output.getvalue())

    def test_snapshot_write_failure_does_not_publish_readiness(self):
        error = ValueError("RANDOM_POOL_FAIL")
        error.diagnostic = {"field": "random_plan", "reason": "SNAPSHOT_WRITE_FAIL"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / "env"
            env = dict(CONTEXT, CHECKIN_CONFIG=json.dumps(configuration()), GITHUB_ENV=str(env_file))
            output = io.StringIO()
            response = Mock(status_code=200)
            response.iter_content.return_value = ["\n".join(
                f"socks5://pool{i}.example.test:1080#" + ("fixed-name" if i == 0 else f"node{i}")
                for i in range(8)).encode()]
            with patch.dict(os.environ, env, clear=True), patch("requests.get", return_value=response), \
                    patch.object(random_snapshot, "write_snapshot", side_effect=error), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                self.assertEqual(routing.main(["prepare", "--manifest", str(root / "manifest.json")]), 1)
            self.assertFalse(env_file.exists())
            self.assertIn("reason=SNAPSHOT_WRITE_FAIL", output.getvalue())
            self.assertNotIn(PRIVATE, output.getvalue())

    def test_workflow_shares_only_ciphertext_and_keeps_public_consumers_separate(self):
        source = Path(".github/workflows/Checkin.yml").read_text(encoding="utf-8")
        prepare = source.split("  prepare:", 1)[1].split("  plan:", 1)[0]
        plan = source.split("  plan:", 1)[1].split("  checkin:", 1)[0]
        worker = source.split("  checkin:", 1)[1].split("  notify:", 1)[0]
        notify = source.split("  notify:", 1)[1].split("  maintenance:", 1)[0]
        self.assertIn("pynacl", prepare)
        self.assertIn("if: env.RANDOM_SNAPSHOT_READY == 'true'", prepare)
        upload = prepare.split("name: Upload encrypted random pool", 1)[1]
        self.assertIn("name: checkin-random-pool", upload)
        self.assertIn("path: random-pool.bin", upload)
        self.assertIn("retention-days: 1", upload)
        self.assertIn("if: env.RANDOM_PLAN != ''", worker)
        self.assertIn("RANDOM_SNAPSHOT_PATH: ${{ env.RANDOM_SNAPSHOT_PATH }}", worker)
        self.assertIn("name: checkin-random-pool", worker)
        self.assertNotIn("checkin-random-pool", plan + notify)
        self.assertNotIn("random-pool.bin", plan + notify)


if __name__ == "__main__":
    unittest.main()
