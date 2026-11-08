import contextlib
import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import proxy_runtime


PRIVATE = "private-download-marker"


class BinaryDownloadRetryTests(unittest.TestCase):
    def setUp(self):
        get = patch.object(proxy_runtime.requests, "get")
        sleep = patch.object(proxy_runtime.time, "sleep")
        self.get, self.sleep = get.start(), sleep.start()
        self.addCleanup(get.stop)
        self.addCleanup(sleep.stop)

    def response(self, status=200, body=b"complete-archive"):
        response = MagicMock()
        response.status_code = status
        response.iter_content.return_value = [body]
        if status != 200:
            response.raise_for_status.side_effect = proxy_runtime.requests.HTTPError(PRIVATE)
        return response

    def test_transient_http_errors_retry_same_url_and_close_each_response(self):
        url = proxy_runtime.DOWNLOAD_PREFIX + "Xray-linux-64.zip"
        for status in (502, 503, 504):
            failed, success = self.response(status), self.response()
            self.get.reset_mock()
            self.sleep.reset_mock()
            self.get.side_effect = [failed, success]
            output = io.StringIO()
            with self.subTest(status=status), contextlib.redirect_stdout(output):
                self.assertEqual(proxy_runtime._archive_bytes(url), b"complete-archive")
            self.assertEqual(self.get.call_args_list, [call(url, stream=True, timeout=30)] * 2)
            self.sleep.assert_called_once_with(2)
            failed.close.assert_called_once()
            success.close.assert_called_once()
            self.assertIn(f"reason=BINARY_HTTP_ERROR status={status}", output.getvalue())
            self.assertIn("reason=BINARY_RETRY attempt=2", output.getvalue())
            self.assertNotIn(PRIVATE, output.getvalue())
            self.assertNotIn(url, output.getvalue())

    def test_request_and_stream_timeouts_restart_without_partial_bytes(self):
        for phase in ("request", "stream"):
            failed, success = self.response(), self.response()
            timeout = proxy_runtime.requests.ReadTimeout(PRIVATE)
            if phase == "stream":
                def chunks(chunk_size):
                    yield b"partial-bytes"
                    raise timeout
                failed.iter_content.side_effect = chunks
            self.get.reset_mock()
            self.sleep.reset_mock()
            self.get.side_effect = [timeout if phase == "request" else failed, success]
            with self.subTest(phase=phase), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(proxy_runtime._archive_bytes("https://download.example.test/core.zip"),
                                 b"complete-archive")
            self.assertEqual(self.get.call_count, 2)
            self.sleep.assert_called_once_with(2)
            success.close.assert_called_once()
            if phase == "stream":
                failed.close.assert_called_once()

    def test_exhaustion_stops_after_three_attempts_and_two_waits(self):
        for cause in ("http", "timeout"):
            responses = [self.response(504) for _ in range(3)]
            self.get.reset_mock()
            self.sleep.reset_mock()
            self.get.side_effect = responses if cause == "http" else [proxy_runtime.requests.Timeout(PRIVATE)] * 3
            output = io.StringIO()
            with self.subTest(cause=cause), contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                    proxy_runtime._archive_bytes("https://download.example.test/core.zip")
            self.assertEqual(self.get.call_count, 3)
            self.assertEqual(self.sleep.call_args_list, [call(2), call(4)])
            self.assertIn("reason=BINARY_RETRY attempt=3", output.getvalue())
            self.assertNotIn("attempt=4", output.getvalue())
            self.assertNotIn(PRIVATE, output.getvalue())
            if cause == "http":
                for response in responses:
                    response.close.assert_called_once()

    def test_other_http_errors_and_failures_are_not_retried(self):
        for cause in (400, 403, 404, 429, 500, "504", True, "request", "read", "size", "not-http"):
            response = self.response(cause) if type(cause) is int or cause in ("504", True) else self.response()
            error = None
            if cause == "request":
                error = proxy_runtime.requests.ConnectionError(PRIVATE)
            elif cause == "read":
                response.iter_content.side_effect = RuntimeError(PRIVATE)
            elif cause == "not-http":
                response.status_code = 504
                response.raise_for_status.side_effect = RuntimeError(PRIVATE)
            self.get.reset_mock()
            self.sleep.reset_mock()
            self.get.side_effect = error
            self.get.return_value = response
            output = io.StringIO()
            with self.subTest(cause=cause), contextlib.redirect_stdout(output), \
                    patch.object(proxy_runtime, "MAX_ARCHIVE_SIZE", 1 if cause == "size" else 100):
                with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                    proxy_runtime._archive_bytes("https://download.example.test/core.zip")
            self.get.assert_called_once()
            self.sleep.assert_not_called()
            self.assertNotIn("BINARY_RETRY", output.getvalue())
            self.assertNotIn(PRIVATE, output.getvalue())
            if error is None:
                response.close.assert_called_once()

    def test_recovered_download_still_checks_hash_before_extracting(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as stream:
            stream.writestr("xray", b"dummy-executable")
        data = archive.getvalue()
        for digest in (hashlib.sha256(data).hexdigest(), "0" * 64):
            failed, success = self.response(504), self.response(body=data)
            self.get.reset_mock()
            self.sleep.reset_mock()
            self.get.side_effect = [failed, success]
            with self.subTest(valid=digest != "0" * 64), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(proxy_runtime.ASSETS, {("Linux", "amd64"): ("Xray-linux-64.zip", digest)}), \
                    contextlib.redirect_stdout(io.StringIO()):
                if digest == "0" * 64:
                    with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                        proxy_runtime.download_binary("Linux", "amd64", Path(directory))
                    self.assertFalse((Path(directory) / "xray").exists())
                else:
                    binary = proxy_runtime.download_binary("Linux", "amd64", Path(directory))
                    self.assertEqual(binary.read_bytes(), b"dummy-executable")
            self.assertEqual(self.get.call_count, 2)


if __name__ == "__main__":
    unittest.main()
