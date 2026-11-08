import base64
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import urlencode

import proxy_runtime
import routing
import subscription_pool


def link(number=0, **extensions):
    query = {"encryption": "none", "security": "tls", "type": "ws",
             "sni": "tls.example.com", "host": "front.example.com", "path": "/", **extensions}
    return (f"vless://12345678-1234-4234-8234-123456789abc@node{number}.example.com:443?"
            + urlencode(query) + "#dummy")


EXTENSIONS = {"fp": "chrome", "ech": "ech.example.com+https://resolver.example.com/dns-query"}


def response_for(lines):
    response = Mock()
    response.iter_content.return_value = [base64.b64encode("\n".join(lines).encode())]
    return response


class VlessWsNormalizationTests(unittest.TestCase):
    def test_extensions_normalize_to_the_existing_client_shape(self):
        node = proxy_runtime.parse_node_link(link(**EXTENSIONS, ed="2048", eh="Sec-WebSocket-Protocol"), "node")
        self.assertEqual(node, {
            "type": "vless", "server": "node0.example.com", "server_port": 443,
            "uuid": "12345678-1234-4234-8234-123456789abc", "tag": "node",
            "tls": {"enabled": True, "server_name": "tls.example.com", "insecure": False},
            "transport": {"type": "ws", "path": "/", "headers": {"Host": "front.example.com"},
                          "max_early_data": 2048, "early_data_header_name": "Sec-WebSocket-Protocol"}})
        config, _ = proxy_runtime.build_proxy_config({"node": node})
        self.assertEqual(config["outbounds"][1]["streamSettings"], {
            "network": "ws", "wsSettings": {"path": "/?ed=2048", "host": "front.example.com"},
            "security": "tls", "tlsSettings": {"serverName": "tls.example.com", "allowInsecure": False}})

    def test_no_early_data_or_certificate_policy_is_injected(self):
        for insecure, expected in (("0", False), ("1", True)):
            node = proxy_runtime.parse_node_link(link(**EXTENSIONS, allowInsecure=insecure), "node")
            config, _ = proxy_runtime.build_proxy_config({"node": node})
            stream = config["outbounds"][1]["streamSettings"]
            self.assertEqual(stream["wsSettings"]["path"], "/")
            self.assertEqual(stream["tlsSettings"], {"serverName": "tls.example.com", "allowInsecure": expected})

    def test_path_early_data_and_other_query_keys_are_preserved(self):
        node = proxy_runtime.parse_node_link(link(**EXTENSIONS, path="/socket?ed=512&marker=one&marker=two"), "node")
        config, _ = proxy_runtime.build_proxy_config({"node": node})
        self.assertEqual(config["outbounds"][1]["streamSettings"]["wsSettings"]["path"],
                         "/socket?ed=512&marker=one&marker=two")

    def test_normalization_does_not_relax_other_validation(self):
        invalid = [link(**EXTENSIONS, type="xhttp", mode="stream-one", extra="{}"),
                   link(**EXTENSIONS, security="none"), link(**EXTENSIONS, type="tcp", path="", host=""),
                   link(**EXTENSIONS, type="grpc", path="", host="", serviceName="rpc"),
                   link(**EXTENSIONS, encryption="unsupported"), link(**EXTENSIONS, extra="{}"),
                   link(**EXTENSIONS, ed="bad"), link(**EXTENSIONS, path="/socket?ed=1", ed="2"),
                   link(**EXTENSIONS).replace("#dummy", "&fp=firefox#dummy"),
                   link(**EXTENSIONS).replace("#dummy", "&ech=another#dummy"),
                   link(**EXTENSIONS).replace("12345678-1234-4234-8234-123456789abc", "invalid-uuid")]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
                proxy_runtime.parse_node_link(value, "node")

    def test_clean_and_extended_aliases_share_pool_identity_and_deduplicate(self):
        response = response_for([link(), link(**EXTENSIONS), link(fp="firefox", ech="ignored")])
        with patch("requests.get", return_value=response), patch("socket.socket", side_effect=AssertionError("network")):
            _, nodes = subscription_pool.load_pool("https://subscription.example.com/sub")
        self.assertEqual(len(nodes), 1)
        self.assertNotIn("utls", nodes[0]["tls"])
        self.assertNotIn("ech_config_list", nodes[0]["tls"])

    def test_mixed_subscription_keeps_ws_and_filters_xhttp(self):
        lines = [link(n, **EXTENSIONS) for n in range(72)] + [
            link(n, **EXTENSIONS, type="xhttp", mode="stream-one", extra="{}") for n in range(72)]
        output = io.StringIO()
        with patch("requests.get", return_value=response_for(lines)), \
                patch("socket.socket", side_effect=AssertionError("network")), contextlib.redirect_stdout(output):
            _, nodes = subscription_pool.load_pool("https://subscription.example.com/sub", diagnostics=True)
        self.assertEqual(len(nodes), 72)
        self.assertTrue(all(node["transport"]["type"] == "ws" for node in nodes))
        for expected in ("total=144", "valid=72", "rejected=72", "distinct=72"):
            self.assertIn(expected, output.getvalue())

    def test_six_account_prepare_excludes_clean_fixed_aliases_and_allocates_unique_random_nodes(self):
        groups = {system: {"accounts": []} for system in ("ubuntu", "macos", "windows")}
        for index in range(6):
            groups[("ubuntu", "macos", "windows")[index // 2]]["accounts"].append({
                "id": f"a{index}", "username": f"a{index}@example.com", "password": "dummy",
                "proxies": [{"link": link(index)}, {"random": 2}]})
        value = {"version": 2, "subscription_url": "https://subscription.example.com/sub", "groups": groups}
        response = response_for([link(n, **EXTENSIONS) for n in range(18)])
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as folder, \
                patch.dict(os.environ, {"CHECKIN_CONFIG": json.dumps(value), "CHECKIN_MODE": ""}), \
                patch("requests.get", return_value=response), patch("socket.socket", side_effect=AssertionError("network")):
            path = Path(folder) / "manifest.json"
            with contextlib.redirect_stdout(output):
                code = routing.main(["prepare", "--manifest", str(path)])
            self.assertEqual(code, 0, output.getvalue())
            manifest = json.loads(path.read_text(encoding="utf-8"))
            _, nodes = subscription_pool.load_pool(value["subscription_url"])
            accounts = subscription_pool.resolve_random_accounts(value, manifest["random"], {}, nodes)
        random_nodes = [a["proxies"][position]["outbound"] for a in accounts for position in (1, 2)]
        self.assertEqual({n["server"] for n in random_nodes}, {f"node{n}.example.com" for n in range(6, 18)})
        self.assertEqual(len(random_nodes), 12)
        self.assertIn("requested=12", output.getvalue())
        self.assertIn("excluded=6", output.getvalue())
        self.assertIn("MANIFEST_READY", output.getvalue())

    def test_pure_fixed_aliases_cannot_be_shared_across_accounts(self):
        value = {"version": 1, "accounts": [
            {"id": "a", "os": "ubuntu", "username": "a@example.com", "password": "dummy",
             "proxies": [{"link": link()}]},
            {"id": "b", "os": "macos", "username": "b@example.com", "password": "dummy",
             "proxies": [{"link": link(**EXTENSIONS)}]}]}
        with self.assertRaisesRegex(ValueError, "^ROUTE_CONFIG_FAIL$"):
            routing.parse_config(json.dumps(value))

    def test_pure_fixed_aliases_cannot_be_repeated_within_one_account(self):
        value = {"version": 1, "accounts": [
            {"id": "a", "os": "ubuntu", "username": "a@example.com", "password": "dummy",
             "proxies": [{"link": link()}, {"link": link(**EXTENSIONS)}]}]}
        with self.assertRaisesRegex(ValueError, "^ROUTE_CONFIG_FAIL$"):
            routing.parse_config(json.dumps(value))


if __name__ == "__main__":
    unittest.main()
