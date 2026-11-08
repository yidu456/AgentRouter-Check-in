import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import app
import proxy_runtime
import routing
import subscription_pool


PRIVATE = "private-worker-marker"


class RandomWorkerDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        for target in ("proxy_runtime.requests.get", "proxy_runtime.subprocess.run",
                       "proxy_runtime.subprocess.Popen", "proxy_runtime.socket.create_connection",
                       "app.browser_login_complete", "app.send_notifications"):
            guard = patch(target, side_effect=AssertionError("external operation blocked"))
            guard.start()
            self.addCleanup(guard.stop)

    def config(self):
        return {"version": 1, "subscription_url": "https://secret.example/sub", "accounts": [
            {"id": "a01", "os": "ubuntu", "username": "dummy@example.test", "password": PRIVATE,
             "proxies": [{"link": "socks5://fixed.example.test:1080"}, {"random": 1}]}]}

    def nodes(self):
        return [{"type": "socks", "server": host, "server_port": 1080, "version": "5"}
                for host in ("random1.example.test", "random2.example.test")]

    def response(self, body=b"socks5://random1.example.test:1080\nsocks5://random2.example.test:1080"):
        response = MagicMock()
        response.status_code = 200
        response.iter_content.return_value = [body]
        return response

    def assert_private(self, output):
        for forbidden in (PRIVATE, "secret.example", "Traceback", "fingerprint=", "seed="):
            self.assertNotIn(forbidden, output)

    def run_worker(self, response=None, error=None, plan=None, config=None, output=None):
        value = self.config() if config is None else config
        if plan is None:
            plan = subscription_pool.make_plan(routing.parse_config(json.dumps(self.config())), {}, self.nodes(), seed="a" * 32)
        output = io.StringIO() if output is None else output
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(app.os.environ, {"CHECKIN_CONFIG": json.dumps(value), "CHECKIN_MODE": "isolated",
                    "GROUP_ID": "g01", "RUNNER_KEY": "ubuntu-24.04", "ACCOUNT_IDS": '["a01"]',
                    "RANDOM_PLAN": json.dumps(plan), "RESULT_PATH": str(Path(directory) / "result.json")}, clear=True), \
                patch.object(app.platform, "system", return_value="Linux"), \
                patch.object(proxy_runtime.requests, "get", return_value=response or self.response(), side_effect=error), \
                patch.object(app, "run_isolated_group", return_value=0) as run, \
                contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as exited:
                app.main()
            path = Path(directory) / "result.json"
            report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        return exited.exception.code, output, report, run.call_count

    def test_worker_distinguishes_request_http_timeout_and_read_failure(self):
        for case, reason in [("request", "SUBSCRIPTION_REQUEST_FAIL"), ("http", "SUBSCRIPTION_HTTP_ERROR"),
                             ("timeout", "SUBSCRIPTION_TIMEOUT"), ("read", "SUBSCRIPTION_READ_FAIL")]:
            response = self.response()
            error = RuntimeError(PRIVATE) if case == "request" else None
            if case == "http":
                response.status_code = 403
                response.raise_for_status.side_effect = proxy_runtime.requests.HTTPError(PRIVATE)
            elif case == "timeout":
                error = proxy_runtime.requests.Timeout(PRIVATE)
            elif case == "read":
                response.iter_content.side_effect = RuntimeError(PRIVATE)
            with self.subTest(case=case):
                code, output, report, calls = self.run_worker(response, error)
                self.assertEqual((code, calls), (1, 0))
                self.assertEqual(report["results"], [{"id": "a01", "quota": None, "stage": "RANDOM_POOL_FAIL"}])
                self.assertIn(f"RANDOM_DIAGNOSTIC field=subscription_url reason={reason}", output.getvalue())
                if case == "http":
                    self.assertIn("status=403", output.getvalue())
                self.assert_private(output.getvalue())

    def test_changed_pool_rejects_plan_with_specific_integrity_reason(self):
        code, output, report, calls = self.run_worker(self.response(b"socks5://changed.example.test:1080\nsocks5://random2.example.test:1080"))
        self.assertEqual((code, calls), (1, 0))
        self.assertEqual(report["results"][0]["stage"], "RANDOM_POOL_FAIL")
        self.assertIn("RANDOM_DIAGNOSTIC field=random_plan reason=RANDOM_PLAN_MISMATCH", output.getvalue())
        self.assert_private(output.getvalue())

    def test_invalid_plan_shape_has_specific_reason_without_dumping_values(self):
        code, output, _, calls = self.run_worker(plan={"seed": PRIVATE, "fingerprint": PRIVATE})
        self.assertEqual((code, calls), (1, 0))
        self.assertIn("RANDOM_DIAGNOSTIC field=random_plan reason=RANDOM_PLAN_INVALID", output.getvalue())
        self.assert_private(output.getvalue())

    def test_resolve_preserves_capacity_reason_and_counts(self):
        value = self.config()
        value["accounts"][0]["proxies"][1] = {"random": 3}
        code, output, _, calls = self.run_worker(config=value)
        self.assertEqual((code, calls), (1, 0))
        self.assertIn("reason=POOL_TOO_SMALL", output.getvalue())
        self.assertIn("available=2 requested=3", output.getvalue())
        self.assert_private(output.getvalue())

    def test_unchanged_pool_still_reaches_owned_runtime(self):
        code, output, _, calls = self.run_worker()
        self.assertEqual((code, calls), (0, 1))
        self.assertNotIn("RANDOM_POOL_FAIL", output.getvalue())
        self.assert_private(output.getvalue())

    def test_closed_stdout_still_writes_random_failure_report(self):
        output = MagicMock()
        output.write.side_effect = BrokenPipeError(PRIVATE)
        code, _, report, calls = self.run_worker(error=RuntimeError(PRIVATE), output=output)
        self.assertEqual((code, calls), (1, 0))
        self.assertEqual(report["results"][0]["stage"], "RANDOM_POOL_FAIL")

    def test_local_run_also_prints_safe_random_reason(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(app.os.environ, {"CHECKIN_CONFIG": json.dumps(self.config()),
                    "BALANCE_HISTORY_PATH": str(Path(directory) / "history.json")}, clear=True), \
                patch.object(app.platform, "system", return_value="Linux"), \
                patch.object(proxy_runtime.requests, "get", side_effect=RuntimeError(PRIVATE)), \
                patch.object(app, "run_isolated_group") as run, \
                patch.object(app, "send_notifications", return_value=None), \
                contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as exited:
                app.main()
            self.assertEqual(exited.exception.code, 1)
            run.assert_not_called()
        self.assertIn("RANDOM_DIAGNOSTIC field=subscription_url reason=SUBSCRIPTION_REQUEST_FAIL", output.getvalue())
        self.assert_private(output.getvalue())

    def test_binary_download_subcauses_are_safe_and_keep_generic_error(self):
        for case, reason in [("request", "BINARY_REQUEST_FAIL"), ("http", "BINARY_HTTP_ERROR"),
                             ("timeout", "BINARY_TIMEOUT"), ("read", "BINARY_READ_FAIL"),
                             ("size", "BINARY_TOO_LARGE")]:
            response = self.response(b"abc")
            error = RuntimeError(PRIVATE) if case == "request" else None
            if case == "http":
                response.status_code = 429
                response.raise_for_status.side_effect = proxy_runtime.requests.HTTPError(PRIVATE)
            elif case == "timeout":
                error = proxy_runtime.requests.Timeout(PRIVATE)
            elif case == "read":
                response.iter_content.side_effect = RuntimeError(PRIVATE)
            output = io.StringIO()
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory, \
                    patch.object(proxy_runtime.requests, "get", return_value=response, side_effect=error), \
                    patch.object(proxy_runtime, "MAX_ARCHIVE_SIZE", 2 if case == "size" else 100), \
                    contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                    proxy_runtime.download_binary("Windows", "amd64", Path(directory))
                self.assertIn(f"PROXY_DIAGNOSTIC stage=BINARY_DOWNLOAD reason={reason}", output.getvalue())
                if case == "http":
                    self.assertIn("status=429", output.getvalue())
                self.assert_private(output.getvalue())

    def test_binary_http_status_rejects_noninteger_or_out_of_range_values(self):
        for status in (PRIVATE, True, 99, 600):
            response = self.response()
            response.status_code = status
            response.raise_for_status.side_effect = proxy_runtime.requests.HTTPError(PRIVATE)
            output = io.StringIO()
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory, \
                    patch.object(proxy_runtime.requests, "get", return_value=response), \
                    contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                    proxy_runtime.download_binary("Windows", "amd64", Path(directory))
                self.assertIn("reason=BINARY_HTTP_ERROR", output.getvalue())
                self.assertNotIn("status=", output.getvalue().splitlines()[0])
                self.assert_private(output.getvalue())


if __name__ == "__main__":
    unittest.main()
