import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import legacy_proxy


class LegacyProxyTests(unittest.TestCase):
    def test_no_source_skips_without_download(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(legacy_proxy, "download_binary") as download:
            self.assertEqual(legacy_proxy.main(), 0)
        download.assert_not_called()

    def test_direct_link_takes_precedence_over_subscription(self):
        with patch.dict(os.environ, {"NODE_LINK": "socks5://proxy.example:1080", "PROXY_CONFIG_URL": "https://subscription.example"}, clear=True), patch.object(legacy_proxy.requests, "get") as get:
            self.assertEqual(legacy_proxy.node_links(), ["socks5://proxy.example:1080"])
        get.assert_not_called()

    def test_node_link_url_precedes_config_url_and_decodes_unnamed_links(self):
        response = MagicMock(content=base64.b64encode(b"socks5://proxy.example:1080\nsocks5://other.example:1080"))
        with patch.dict(os.environ, {"NODE_LINK": "https://first.example/sub", "PROXY_CONFIG_URL": "https://other.example/sub"}, clear=True), patch.object(legacy_proxy.requests, "get", return_value=response) as get:
            self.assertEqual(legacy_proxy.node_links(), ["socks5://proxy.example:1080", "socks5://other.example:1080"])
        get.assert_called_once_with("https://first.example/sub", timeout=30)

    def run_candidates(self, directory, links, probe_results, env_path=None):
        runtime = Path(directory) / "runtime"
        runtime.mkdir()
        first, selected = MagicMock(), MagicMock()
        env = {"GITHUB_ENV": str(env_path or (Path(directory) / "github-env"))}
        with patch.dict(os.environ, env, clear=True), patch.object(legacy_proxy, "node_links", return_value=links), patch.object(legacy_proxy.tempfile, "mkdtemp", return_value=str(runtime)), patch.object(legacy_proxy, "download_binary", return_value=runtime / "xray"), patch.object(legacy_proxy, "start_proxy", side_effect=[(first, {"legacy": "http://127.0.0.1:18080"}), (selected, {"legacy": "http://127.0.0.1:18080"})]) as start, patch.object(legacy_proxy, "_stop_child") as stop, patch.object(legacy_proxy, "probe", side_effect=probe_results), patch.object(legacy_proxy.time, "sleep"):
            result = legacy_proxy.main()
        return result, first, selected, start, stop, runtime

    def test_failed_candidate_closes_before_selected_proxy_export(self):
        with tempfile.TemporaryDirectory() as directory:
            result, first, selected, start, stop, runtime = self.run_candidates(
                directory, ["socks5://first.example:1080", "socks5://second.example:1080"], [False, True, True])
            self.assertEqual(result, 0)
            self.assertEqual(start.call_count, 2)
            stop.assert_called_once_with(first)
            self.assertEqual((Path(directory) / "github-env").read_text(), "PROXY_SERVER=http://127.0.0.1:18080\n")
            self.assertTrue(runtime.is_dir())

    def test_all_failed_candidates_close_and_remove_owned_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            result, first, selected, start, stop, runtime = self.run_candidates(
                directory, ["socks5://first.example:1080", "socks5://second.example:1080"], [False, False])
            self.assertEqual(result, 1)
            self.assertEqual(stop.call_args_list, [call(first), call(selected)])
            self.assertFalse(runtime.exists())
            self.assertFalse((Path(directory) / "github-env").exists())

    def test_export_failure_closes_selected_child(self):
        with tempfile.TemporaryDirectory() as directory:
            result, first, selected, start, stop, runtime = self.run_candidates(
                directory, ["socks5://first.example:1080"], [True, True], Path(directory))
            self.assertEqual(result, 1)
            stop.assert_called_once_with(first)
            self.assertFalse(runtime.exists())

    def test_malformed_link_is_skipped_without_start(self):
        with tempfile.TemporaryDirectory() as directory:
            result, first, selected, start, stop, runtime = self.run_candidates(
                directory, ["vless://truncated@proxy.example:443", "socks5://second.example:1080"], [True, True])
            self.assertEqual(result, 0)
            self.assertEqual(start.call_count, 1)
            stop.assert_not_called()

    def test_probe_is_explicit_and_ignores_environment_proxy(self):
        session = MagicMock()
        with patch.object(legacy_proxy.requests, "Session", return_value=session):
            self.assertTrue(legacy_proxy.probe("http://127.0.0.1:18080", 10))
        self.assertFalse(session.__enter__.return_value.trust_env)
        session.__enter__.return_value.get.assert_called_once_with(
            "https://api.ipify.org", proxies={"http": "http://127.0.0.1:18080", "https": "http://127.0.0.1:18080"}, timeout=10)


if __name__ == "__main__":
    unittest.main()
