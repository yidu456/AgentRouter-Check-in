import contextlib
import hashlib
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import app
import proxy_runtime


PRIVATE = "private-diagnostic-marker"


class ProxyDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        # Unexpected external work must fail rather than contact nodes or accounts.
        for target in ("proxy_runtime.requests.get", "proxy_runtime.subprocess.run",
                       "proxy_runtime.subprocess.Popen", "proxy_runtime.socket.create_connection",
                       "app.browser_login_complete", "app.send_notifications"):
            guard = patch(target, side_effect=AssertionError("external operation blocked"))
            guard.start()
            self.addCleanup(guard.stop)

    def assert_private(self, output):
        self.assertNotIn(PRIVATE, output)
        self.assertNotIn("Traceback", output)
        self.assertNotIn("secret.example", output)

    def test_download_failures_identify_boundary_without_changing_safe_error(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("xray.exe", b"dummy binary")
        data = archive.getvalue()
        cases = [
            ("platform", "BINARY_PLATFORM"), ("network", "BINARY_DOWNLOAD"),
            ("hash", "BINARY_HASH"), ("zip", "BINARY_EXTRACT"),
            ("write", "BINARY_WRITE"),
        ]
        for case, stage in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                body = b"not a zip" if case == "zip" else data
                expected = "0" * 64 if case == "hash" else hashlib.sha256(body).hexdigest()
                response = MagicMock()
                response.iter_content.return_value = [body]
                if case == "write":
                    (Path(directory) / "xray.exe").write_bytes(b"existing")
                output = io.StringIO()
                with patch.dict(proxy_runtime.ASSETS, {("Windows", "amd64"): (
                        "Xray-windows-64.zip", expected)}, clear=True), \
                        patch.object(proxy_runtime.requests, "get", return_value=response) as get, \
                        contextlib.redirect_stdout(output):
                    if case == "network":
                        get.side_effect = RuntimeError(PRIVATE)
                    with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                        proxy_runtime.download_binary("Windows", "arm64" if case == "platform" else "amd64",
                                                      Path(directory))
                self.assertIn(f"PROXY_DIAGNOSTIC stage={stage} status=FAIL", output.getvalue())
                self.assert_private(output.getvalue())
                if case == "write":
                    self.assertEqual((Path(directory) / "xray.exe").read_bytes(), b"existing")

    def test_native_check_failure_distinguishes_rejection_timeout_and_execution(self):
        outcomes = [
            (subprocess.CompletedProcess([PRIVATE], 1, stdout=PRIVATE, stderr=PRIVATE), "NATIVE_CHECK_REJECTED"),
            (subprocess.TimeoutExpired(PRIVATE, 15, output=PRIVATE, stderr=PRIVATE), "NATIVE_CHECK_TIMEOUT"),
            (OSError(PRIVATE), "NATIVE_CHECK_EXEC_FAIL"),
        ]
        for outcome, stage in outcomes:
            output = io.StringIO()
            with self.subTest(stage=stage), patch.object(proxy_runtime.subprocess, "run") as run, \
                    contextlib.redirect_stdout(output):
                if isinstance(outcome, Exception):
                    run.side_effect = outcome
                else:
                    run.return_value = outcome
                self.assertFalse(proxy_runtime._check_config(Path(PRIVATE), Path(PRIVATE + ".json")))
                self.assertIn(f"PROXY_DIAGNOSTIC stage={stage}", output.getvalue())
                self.assert_private(output.getvalue())

    def outbounds(self):
        return {"a01_p01": {"type": "socks", "server": "secret.example", "server_port": 1080,
                            "version": "5", "username": "dummy", "password": PRIVATE}}

    def test_start_failures_identify_boundary_and_keep_runtime_error(self):
        cases = [
            ("candidate", "CANDIDATE_CHECK"), ("group_write", "GROUP_CONFIG"),
            ("group_check", "GROUP_CHECK"), ("ports", "PORT_RESERVE"),
            ("spawn", "PROCESS_SPAWN"), ("exit", "PROCESS_EXIT"),
            ("timeout", "PORT_READY"),
        ]
        for case, stage in cases:
            child = MagicMock()
            child.poll.return_value = 1 if case == "exit" else None
            check_results = [False] if case == "candidate" else [True, case != "group_check"]
            output = io.StringIO()
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory, \
                    contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(proxy_runtime, "_check_config", side_effect=check_results))
                stack.enter_context(patch.object(proxy_runtime, "_ports_available", return_value=case != "ports"))
                stack.enter_context(patch.object(proxy_runtime, "_ports_ready", return_value=False))
                popen = stack.enter_context(patch.object(proxy_runtime.subprocess, "Popen", return_value=child))
                stack.enter_context(patch.object(proxy_runtime.time, "monotonic", side_effect=[0, 20]))
                if case == "spawn":
                    popen.side_effect = OSError(PRIVATE)
                if case == "group_write":
                    stack.enter_context(patch.object(proxy_runtime, "_write_config", side_effect=[None, OSError(PRIVATE)]))
                with contextlib.redirect_stdout(output), self.assertRaisesRegex(RuntimeError, "^PROXY_START_FAIL$"):
                    proxy_runtime.start_proxy(self.outbounds(), Path(PRIVATE), Path(directory))
                self.assertIn(f"PROXY_DIAGNOSTIC stage={stage} status=FAIL", output.getvalue())
                self.assert_private(output.getvalue())
                if case == "timeout":
                    child.terminate.assert_called_once()

    def test_rejected_candidate_is_counted_without_leaking_tag_or_changing_owned_endpoint(self):
        outbounds = self.outbounds()
        outbounds[PRIVATE] = {"type": "direct"}
        child = MagicMock()
        child.poll.return_value = None
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(proxy_runtime, "_check_config", return_value=True), \
                patch.object(proxy_runtime, "_ports_available", return_value=True), \
                patch.object(proxy_runtime, "_ports_ready", return_value=True), \
                patch.object(proxy_runtime.subprocess, "Popen", return_value=child), \
                contextlib.redirect_stdout(output):
            with proxy_runtime.group_proxy(outbounds, Path(PRIVATE), Path(directory)) as endpoints:
                self.assertEqual(endpoints, {"a01_p01": "http://127.0.0.1:18080"})
        self.assertIn("PROXY_DIAGNOSTIC stage=CANDIDATE_CONFIG_FAIL candidate=2", output.getvalue())
        self.assertIn("PROXY_DIAGNOSTIC stage=CANDIDATE_CHECK total=2 valid=1 rejected=1", output.getvalue())
        self.assertIn("PROXY_DIAGNOSTIC stage=PROXY_READY", output.getvalue())
        self.assert_private(output.getvalue())
        child.terminate.assert_called_once()

    def test_isolated_group_prints_failure_phase_and_distinguishes_account_execution(self):
        routes = [{"id": "a01", "profile": {}, "proxies": [{"link": "socks5://one.test:1080"}]},
                  {"id": "a02", "profile": {}, "proxies": [{"link": "socks5://two.test:1080"}]}]
        group = {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["a01", "a02"], "mode": "isolated"}
        for phase in ("RUNTIME_DIR", "BINARY_DOWNLOAD", "PROXY_START", "ACCOUNT_RUN"):
            output = io.StringIO()
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(app.os.environ, {"RUNNER_TEMP": directory}), \
                    patch.object(proxy_runtime, "download_binary", return_value=Path("dummy")) as download, \
                    patch.object(proxy_runtime, "group_proxy") as runtime, \
                    patch.object(app, "checkin_assigned_account", side_effect=RuntimeError(PRIVATE)), \
                    contextlib.redirect_stdout(output):
                runtime.return_value.__enter__.return_value = {
                    "a01_p01": "http://127.0.0.1:18080", "a02_p01": "http://127.0.0.1:18081"}
                if phase == "RUNTIME_DIR":
                    app.os.environ["RUNNER_TEMP"] = str(Path(directory) / "missing-parent")
                elif phase == "BINARY_DOWNLOAD":
                    download.side_effect = RuntimeError(PRIVATE)
                elif phase == "PROXY_START":
                    runtime.return_value.__enter__.side_effect = RuntimeError(PRIVATE)
                path = Path(directory) / "result.json"
                self.assertEqual(app.run_isolated_group(routes, group, path), 1)
                stages = [row["stage"] for row in json.loads(path.read_text(encoding="utf-8"))["results"]]
                self.assertEqual(stages, ["UNEXPECTED" if phase == "ACCOUNT_RUN" else "PROXY_START_FAIL"] * 2)
                self.assertIn(f"ISOLATED_DIAGNOSTIC phase={phase} status=FAIL", output.getvalue())
                self.assert_private(output.getvalue())

    def test_worker_native_rejection_is_visible_with_safe_report_and_no_login(self):
        routes = [{"id": "a01", "profile": {}, "proxies": [{"link": "socks5://one.test:1080"}]}]
        group = {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["a01"], "mode": "isolated"}
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(app.os.environ, {"RUNNER_TEMP": directory}), \
                patch.object(proxy_runtime, "download_binary", return_value=Path(PRIVATE)), \
                patch.object(proxy_runtime.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [PRIVATE], 1, stdout=PRIVATE, stderr=PRIVATE)), \
                patch.object(output, "flush", wraps=output.flush) as flush, \
                contextlib.redirect_stdout(output):
            path = Path(directory) / "result.json"
            self.assertEqual(app.run_isolated_group(routes, group, path), 1)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["results"], [
                {"id": "a01", "quota": None, "stage": "PROXY_START_FAIL"}])
        self.assertIn("PROXY_DIAGNOSTIC stage=NATIVE_CHECK_REJECTED", output.getvalue())
        self.assertIn("PROXY_DIAGNOSTIC stage=CANDIDATE_CHECK total=1 valid=0 rejected=1", output.getvalue())
        self.assertIn("ISOLATED_DIAGNOSTIC phase=PROXY_START status=FAIL", output.getvalue())
        self.assert_private(output.getvalue())
        self.assertGreater(flush.call_count, 0)

    def test_account_exception_keeps_completed_account_result(self):
        routes = [{"id": account_id, "profile": {}, "proxies": [{"link": f"socks5://{account_id}.test:1080"}]}
                  for account_id in ("a01", "a02")]
        group = {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["a01", "a02"], "mode": "isolated"}
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(app.os.environ, {"RUNNER_TEMP": directory}), \
                patch.object(proxy_runtime, "download_binary", return_value=Path("dummy")), \
                patch.object(proxy_runtime, "group_proxy") as runtime, \
                patch.object(app, "checkin_assigned_account", side_effect=[
                    ({"quota": 123}, "SUCCESS"), RuntimeError(PRIVATE)]), \
                contextlib.redirect_stdout(output):
            runtime.return_value.__enter__.return_value = {
                "a01_p01": "http://127.0.0.1:18080", "a02_p01": "http://127.0.0.1:18081"}
            path = Path(directory) / "result.json"
            self.assertEqual(app.run_isolated_group(routes, group, path), 1)
            rows = json.loads(path.read_text(encoding="utf-8"))["results"]
        self.assertEqual([(row["quota"], row["stage"]) for row in rows], [(123, "SUCCESS"), (None, "UNEXPECTED")])
        self.assertIn("ISOLATED_DIAGNOSTIC phase=ACCOUNT_RUN status=FAIL", output.getvalue())
        self.assert_private(output.getvalue())

    def test_closed_output_preserves_native_boolean_contract(self):
        for error in (BrokenPipeError(PRIVATE), ValueError(PRIVATE)):
            output = MagicMock()
            output.write.side_effect = error
            with self.subTest(error=type(error).__name__), \
                    patch.object(proxy_runtime.subprocess, "run", return_value=subprocess.CompletedProcess([PRIVATE], 1)), \
                    contextlib.redirect_stdout(output):
                self.assertFalse(proxy_runtime._check_config(Path(PRIVATE), Path(PRIVATE + ".json")))

    def test_closed_output_preserves_binary_success_and_safe_failure(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("xray.exe", b"dummy binary")
        data = archive.getvalue()
        for valid in (True, False):
            output = MagicMock()
            output.write.side_effect = BrokenPipeError(PRIVATE)
            digest = hashlib.sha256(data).hexdigest() if valid else "0" * 64
            with self.subTest(valid=valid), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(proxy_runtime.ASSETS, {("Windows", "amd64"): ("Xray-windows-64.zip", digest)}, clear=True), \
                    patch.object(proxy_runtime, "_archive_bytes", return_value=data), \
                    contextlib.redirect_stdout(output):
                if valid:
                    path = proxy_runtime.download_binary("Windows", "amd64", Path(directory))
                    self.assertEqual(path.read_bytes(), b"dummy binary")
                else:
                    with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                        proxy_runtime.download_binary("Windows", "amd64", Path(directory))

    def test_closed_output_preserves_startup_and_owned_process_cleanup(self):
        for ready in (True, False):
            for error in (BrokenPipeError(PRIVATE), ValueError(PRIVATE)):
                output = MagicMock()
                output.write.side_effect = error
                child = MagicMock()
                child.poll.return_value = None
                with self.subTest(ready=ready, error=type(error).__name__), tempfile.TemporaryDirectory() as directory, \
                        patch.object(proxy_runtime, "_check_config", return_value=True), \
                        patch.object(proxy_runtime, "_ports_available", return_value=True), \
                        patch.object(proxy_runtime, "_ports_ready", return_value=ready), \
                        patch.object(proxy_runtime.subprocess, "Popen", return_value=child), \
                        patch.object(proxy_runtime.time, "monotonic", side_effect=[0, 20]), \
                        contextlib.redirect_stdout(output):
                    if ready:
                        with proxy_runtime.group_proxy(self.outbounds(), Path(PRIVATE), Path(directory)) as endpoints:
                            self.assertEqual(endpoints, {"a01_p01": "http://127.0.0.1:18080"})
                    else:
                        with self.assertRaisesRegex(RuntimeError, "^PROXY_START_FAIL$"):
                            proxy_runtime.start_proxy(self.outbounds(), Path(PRIVATE), Path(directory))
                    child.terminate.assert_called_once()

    def test_closed_output_does_not_prevent_group_failure_report(self):
        routes = [{"id": "a01", "profile": {}, "proxies": [{"link": "socks5://one.test:1080"}]}]
        group = {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["a01"], "mode": "isolated"}
        output = MagicMock()
        output.write.side_effect = BrokenPipeError(PRIVATE)
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(app.os.environ, {"RUNNER_TEMP": directory}), \
                patch.object(proxy_runtime, "download_binary", side_effect=RuntimeError(PRIVATE)), \
                contextlib.redirect_stdout(output):
            path = Path(directory) / "result.json"
            self.assertEqual(app.run_isolated_group(routes, group, path), 1)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["results"], [
                {"id": "a01", "quota": None, "stage": "PROXY_START_FAIL"}])


if __name__ == "__main__":
    unittest.main()
