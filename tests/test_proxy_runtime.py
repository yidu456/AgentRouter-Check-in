import base64
import hashlib
import io
import json
import socket
import stat
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import proxy_runtime


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class Response:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size):
        for offset in range(0, len(self.content), chunk_size):
            yield self.content[offset:offset + chunk_size]


class NodeParsingTests(unittest.TestCase):
    def test_duplicate_decoded_names_fail_even_for_unusable_neighbors(self):
        for neighbor in ("socks5://bad.example:0#sa%6De", "ss://unsupported#same"):
            body = (neighbor + "\nsocks5://good.example:1080#same").encode()
            with self.subTest(neighbor=neighbor), patch.object(
                    proxy_runtime.requests, "get", return_value=Response(body)):
                with self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
                    proxy_runtime.load_node_links("https://example.test/s")

    def test_format_guards_reject_uri_looking_yaml_and_json_before_and_after_decoding(self):
        documents = [b"proxies: |\n  socks5://good.example:1080#good",
                     b'{"proxies": [\n socks5://good.example:1080#good\n]}']
        for document in documents:
            for body in (document, b64(document).encode()):
                with self.subTest(body=body), patch.object(
                        proxy_runtime.requests, "get", return_value=Response(body)):
                    with self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
                        proxy_runtime.load_node_links("https://example.test/s")

    def test_loads_plain_subscription_once_and_decodes_names(self):
        body = (
            b"# ignored\r\n"
            b"socks5://user:pass@proxy.example:1080#node%20one\r\n"
            b"trojan://secret@proxy.example:443?security=tls#node-two\r\n"
        )
        with patch.object(proxy_runtime.requests, "get", return_value=Response(body)) as get:
            links = proxy_runtime.load_node_links("https://subscription.example/nodes")
        self.assertEqual(list(links), ["node one", "node-two"])
        get.assert_called_once_with("https://subscription.example/nodes", timeout=30)

    def test_loads_unpadded_base64url_subscription(self):
        link = "socks://[2001:db8::1]:1080#ipv6"
        encoded = b64((link + "\n").encode()).encode()
        with patch.object(proxy_runtime.requests, "get", return_value=Response(encoded)):
            self.assertEqual(proxy_runtime.load_node_links("https://example.test/s"), {"ipv6": link})

    def test_rejects_duplicate_missing_names_and_non_link_formats(self):
        invalid_bodies = [
            b"socks5://proxy.example:1080#same\nsocks5://other.example:1080#same",
            b"socks5://proxy.example:1080",
            b"proxies:\n  - name: node-a",
            b'{"proxies": []}',
        ]
        for body in invalid_bodies:
            with self.subTest(body=body), patch.object(
                proxy_runtime.requests, "get", return_value=Response(body)
            ):
                with self.assertRaisesRegex(ValueError, "NODE_CONFIG_FAIL"):
                    proxy_runtime.load_node_links("https://example.test/s")

    def test_subscription_network_error_is_safe(self):
        with patch.object(proxy_runtime.requests, "get", side_effect=RuntimeError("secret URL")):
            with self.assertRaisesRegex(ValueError, "NODE_CONFIG_FAIL") as error:
                proxy_runtime.load_node_links("https://example.test/private-token")
        self.assertNotIn("secret", str(error.exception))

    def test_named_socks_node_decodes_auth_and_ipv6(self):
        outbound = proxy_runtime.parse_node_link(
            "socks5://unit%20user:p%40ss@[2001:db8::1]:1080#node-a", "out-a01"
        )
        self.assertEqual(outbound, {
            "type": "socks", "server": "2001:db8::1", "server_port": 1080,
            "version": "5", "tag": "out-a01", "username": "unit user", "password": "p@ss",
        })

    def test_parses_vless_tls_ws_and_reality_grpc(self):
        ws = proxy_runtime.parse_node_link(
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443"
            "?type=ws&security=tls&sni=edge.test&host=cdn.test&path=%2Fws#node", "out-a"
        )
        self.assertEqual(ws["transport"], {"type": "ws", "path": "/ws", "headers": {"Host": "cdn.test"}})
        self.assertEqual(ws["tls"], {"enabled": True, "server_name": "edge.test", "insecure": False})

        reality = proxy_runtime.parse_node_link(
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443"
            "?type=grpc&serviceName=svc&security=reality&pbk=public-key&sid=0a0b#node", "out-b"
        )
        self.assertEqual(reality["transport"], {"type": "grpc", "service_name": "svc"})
        self.assertEqual(reality["tls"]["reality"], {
            "enabled": True, "public_key": "public-key", "short_id": "0a0b",
        })
        self.assertEqual(reality["tls"]["utls"], {"enabled": True, "fingerprint": "chrome"})

        firefox = proxy_runtime.parse_node_link(
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443"
            "?security=reality&pbk=public-key&sid=0a&fp=firefox#node", "out-c"
        )
        self.assertEqual(firefox["tls"]["utls"]["fingerprint"], "firefox")

    def test_vless_ws_early_data_preserves_path_host_and_explicit_tls_policy(self):
        link = (
            "vless://123e4567-e89b-12d3-a456-426614174000@proxy.example:443"
            "?allowInsecure=1&ed=2048&eh=Sec-WebSocket-Protocol&encryption=none"
            "&host=cdn.example&path=%2F%3Fed%3D2048%26route%3DSG"
            "&security=tls&sni=tls.example&type=ws#dummy-node"
        )
        outbound = proxy_runtime.parse_node_link(link, "out-a")
        self.assertEqual(outbound["transport"], {
            "type": "ws", "path": "/?ed=2048&route=SG", "headers": {"Host": "cdn.example"},
            "max_early_data": 2048, "early_data_header_name": "Sec-WebSocket-Protocol",
        })
        self.assertEqual(outbound["tls"], {"enabled": True, "server_name": "tls.example", "insecure": True})
        with patch.object(proxy_runtime.requests, "get", return_value=Response(link.encode())):
            self.assertEqual(proxy_runtime.load_node_links("https://example.test/s"), {"dummy-node": link})

    def test_vless_ws_early_data_optional_fields_and_uint32_boundaries(self):
        base = "vless://123e4567-e89b-12d3-a456-426614174000@proxy.example:443?type=ws&security=tls"
        for value in (0, 2048, 4294967295):
            with self.subTest(value=value):
                outbound = proxy_runtime.parse_node_link(base + f"&ed={value}", "out-a")
                self.assertEqual(outbound["transport"], {"type": "ws", "max_early_data": value})
                self.assertFalse(outbound["tls"]["insecure"])
        outbound = proxy_runtime.parse_node_link(base + "&ed=0&eh=", "out-a")
        self.assertEqual(outbound["transport"]["early_data_header_name"], "")

    def test_vless_rejects_invalid_early_data_fields_and_shortened_uuid(self):
        base = "vless://123e4567-e89b-12d3-a456-426614174000@proxy.example:443?security=tls"
        queries = ["&type=ws&ed=-1", "&type=ws&ed=1.5", "&type=ws&ed=true", "&type=ws&ed=",
                   "&type=ws&ed=4294967296", "&type=ws&ed=2048&eh=bad%3Aheader",
                   "&type=ws&ed=2048&eh=bad%0D%0Aheader", "&type=ws&eh=bad%20header",
                   "&type=tcp&ed=2048", "&type=grpc&serviceName=svc&ed=2048"]
        for query in queries:
            with self.subTest(query=query), self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
                proxy_runtime.parse_node_link(base + query, "out-a")
        with self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
            proxy_runtime.parse_node_link(
                "vless://123e4567-e89b@proxy.example:443?type=ws&security=tls&ed=2048&eh=Sec-WebSocket-Protocol",
                "out-a",
            )

    def test_subscription_skips_unusable_neighbors_but_keeps_named_nodes(self):
        unnamed_vmess = "vmess://" + b64(json.dumps({
            "add": "vmess.test", "port": 443,
            "id": "123e4567-e89b-12d3-a456-426614174000",
        }).encode())
        body = "\n".join([
            "vmess://not-base64",
            unnamed_vmess,
            "ss://unsupported#neighbor",
            "socks5://host.test:1080",
            "socks5://host.test:1080#kept",
        ]).encode()
        with patch.object(proxy_runtime.requests, "get", return_value=Response(body)):
            self.assertEqual(
                proxy_runtime.load_node_links("https://example.test/subscription"),
                {"kept": "socks5://host.test:1080#kept"},
            )

    def test_subscription_with_no_usable_named_nodes_fails(self):
        body = b"vmess://not-base64\nss://unsupported#neighbor\nsocks5://host.test:1080"
        with patch.object(proxy_runtime.requests, "get", return_value=Response(body)):
            with self.assertRaisesRegex(ValueError, "NODE_CONFIG_FAIL"):
                proxy_runtime.load_node_links("https://example.test/subscription")

    def test_parses_vmess_tcp_and_ws(self):
        payload = {
            "v": "2", "ps": "node", "add": "vmess.example", "port": "443",
            "id": "123e4567-e89b-12d3-a456-426614174000", "aid": "0",
            "net": "ws", "tls": "tls", "sni": "sni.example", "host": "cdn.example", "path": "/v",
        }
        outbound = proxy_runtime.parse_node_link("vmess://" + b64(json.dumps(payload).encode()), "out-v")
        self.assertEqual(outbound["security"], "auto")
        self.assertEqual(outbound["transport"], {
            "type": "ws", "path": "/v", "headers": {"Host": "cdn.example"},
        })
        payload.update(net="tcp", tls="")
        payload.pop("sni")
        payload.pop("host")
        payload.pop("path")
        outbound = proxy_runtime.parse_node_link("vmess://" + b64(json.dumps(payload).encode()), "out-tcp")
        self.assertNotIn("transport", outbound)
        self.assertNotIn("tls", outbound)

    def test_parses_trojan_hysteria2_and_alias(self):
        trojan = proxy_runtime.parse_node_link(
            "trojan://p%40ss@trojan.example:443?type=grpc&serviceName=rpc&sni=sni.test#n", "out-t"
        )
        self.assertEqual(trojan["password"], "p@ss")
        self.assertEqual(trojan["tls"]["server_name"], "sni.test")
        for scheme in ("hysteria2", "hy2"):
            with self.subTest(scheme=scheme):
                hy2 = proxy_runtime.parse_node_link(
                    f"{scheme}://secret@hy.example:8443?sni=edge.test&insecure=false"
                    "&obfs=salamander&obfs-password=pepper#n", "out-h"
                )
                self.assertEqual(hy2["type"], "hysteria2")
                self.assertEqual(hy2["obfs"], {"type": "salamander", "password": "pepper"})

    def test_salamander_link_password_requires_four_utf8_bytes(self):
        base = "hy2://dummy-auth@hy.example:8443?obfs=salamander&obfs-password="
        for encoded in ("a", "abc", "%E7%95%8C"):
            with self.subTest(encoded=encoded), self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
                proxy_runtime.parse_node_link(base + encoded, "node")
        for encoded, password in [("abcd", "abcd"), ("%C3%A9%C3%A9", "\u00e9\u00e9")]:
            with self.subTest(encoded=encoded):
                node = proxy_runtime.parse_node_link(base + encoded, "node")
                self.assertEqual(node["obfs"]["password"], password)

    def test_ws_path_preserves_repeated_non_ed_parameters(self):
        base = "vless://123e4567-e89b-12d3-a456-426614174000@proxy.test:443?type=ws"
        for suffix, path in [("&path=%2Fws%3Froute%3Done%26route%3Dtwo", "/ws?route=one&route=two"),
                             ("&path=%2Fws%3Froute%3Done%26route%3Dtwo&ed=2048", "/ws?route=one&route=two"),
                             ("&path=%2Fws%3Froute%3Done%26route%3Dtwo%26ed%3D2048&ed=2048", "/ws?route=one&route=two&ed=2048")]:
            with self.subTest(suffix=suffix):
                node = proxy_runtime.parse_node_link(base + suffix, "node")
                self.assertEqual(node["transport"]["path"], path)

    def test_rejects_invalid_or_unrepresentable_node_fields(self):
        invalid = [
            "socks5://host.test:0#n",
            "vless://not-a-uuid@host.test:443?security=tls#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?type=kcp#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?sni=x#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?security=reality&pbk=k&sid=nope#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?security=tls&fp=chrome#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?security=tls&pbk=ignored&sid=0a#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?security=tls&flow=unsupported#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?type=tcp&path=%2Fignored#n",
            "vless://123e4567-e89b-12d3-a456-426614174000@host.test:443?security=tls&security=none#n",
            "socks5://bad%ZZ:secret@host.test:1080#n",
            "hy2://secret@host.test:443?insecure=maybe#n",
        ]
        for link in invalid:
            with self.subTest(link=link), self.assertRaisesRegex(ValueError, "NODE_CONFIG_FAIL"):
                proxy_runtime.parse_node_link(link, "out-a")

        vmess = {
            "add": "vmess.test", "port": 443,
            "id": "123e4567-e89b-12d3-a456-426614174000", "net": "tcp",
            "tls": "", "allowInsecure": True,
        }
        with self.assertRaisesRegex(ValueError, "NODE_CONFIG_FAIL"):
            proxy_runtime.parse_node_link("vmess://" + b64(json.dumps(vmess).encode()), "out-a")
        for field, value in (("port", 443.5), ("allowInsecure", 1.0)):
            invalid_vmess = dict(vmess, tls="tls", allowInsecure=False, port=443)
            invalid_vmess[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "NODE_CONFIG_FAIL"):
                proxy_runtime.parse_node_link(
                    "vmess://" + b64(json.dumps(invalid_vmess).encode()), "out-a"
                )

    def test_accepts_numeric_insecure_flag_used_by_share_links(self):
        outbound = proxy_runtime.parse_node_link(
            "hy2://secret@host.test:443?insecure=1#n", "out-a"
        )
        self.assertTrue(outbound["tls"]["insecure"])

    def test_rejects_early_data_semantics_xray_cannot_preserve(self):
        base = "vless://123e4567-e89b-12d3-a456-426614174000@proxy.example:443?type=ws&security=tls"
        queries = ["&ed=2048&eh=X-Early-Data", "&ed=2048&path=%2F%3Fed%3D1024",
                   "&path=%2F%3Fed%3D2048%26ed%3D2048", "&path=%2F%3Fed%3Dnope",
                   "&ed=2048&eh=", "&path=%2F%3Fed%3D4294967296"]
        for query in queries:
            with self.subTest(query=query), self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
                proxy_runtime.parse_node_link(base + query, "out-a")

    def test_rejects_reality_ws_and_vision_non_tcp(self):
        base = "vless://123e4567-e89b-12d3-a456-426614174000@proxy.example:443?"
        queries = ["security=reality&pbk=public-key&sid=0a&type=ws",
                   "security=reality&pbk=public-key&sid=0a&allowInsecure=1",
                   "security=tls&flow=xtls-rprx-vision&type=ws",
                   "security=tls&flow=xtls-rprx-vision&type=grpc&serviceName=svc"]
        for query in queries:
            with self.subTest(query=query), self.assertRaisesRegex(ValueError, "^NODE_CONFIG_FAIL$"):
                proxy_runtime.parse_node_link(base + query, "out-a")


class BinaryDownloadTests(unittest.TestCase):
    def make_tar(self, member_name, data=b"binary", kind="file"):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            info = tarfile.TarInfo(member_name)
            if kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "elsewhere"
                archive.addfile(info)
            else:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return stream.getvalue()

    def make_zip(self, member_name, data=b"binary", symlink=False):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            info = zipfile.ZipInfo(member_name)
            info.create_system = 3
            info.external_attr = ((stat.S_IFLNK if symlink else stat.S_IFREG) | 0o700) << 16
            archive.writestr(info, b"elsewhere" if symlink else data)
        return stream.getvalue()

    def download(self, system, machine, archive, asset):
        digest = hashlib.sha256(archive).hexdigest()
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            proxy_runtime.ASSETS, {(system, proxy_runtime._normalize_machine(machine)): (asset, digest)}, clear=True
        ), patch.object(proxy_runtime.requests, "get", return_value=Response(archive)) as get:
            path = proxy_runtime.download_binary(system, machine, Path(directory))
            data = path.read_bytes()
        get.assert_called_once_with(proxy_runtime.DOWNLOAD_PREFIX + asset, stream=True, timeout=30)
        return path.name, data

    def test_downloads_verified_zip_for_supported_posix_platforms(self):
        for system, machine, asset in [
            ("Linux", "x86_64", "Xray-linux-64.zip"),
            ("Linux", "aarch64", "Xray-linux-arm64-v8a.zip"),
            ("Darwin", "amd64", "Xray-macos-64.zip"),
            ("Darwin", "arm64", "Xray-macos-arm64-v8a.zip"),
        ]:
            with self.subTest(system=system, machine=machine):
                archive = self.make_zip("xray")
                name, data = self.download(system, machine, archive, asset)
                self.assertEqual((name, data), ("xray", b"binary"))

    def test_downloads_verified_windows_zip(self):
        asset = "Xray-windows-64.zip"
        archive = self.make_zip("xray.exe")
        self.assertEqual(self.download("Windows", "AMD64", archive, asset), ("xray.exe", b"binary"))

    def test_accepts_zip_regular_member_without_unix_file_type_bits(self):
        asset = "Xray-windows-64.zip"
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            info = zipfile.ZipInfo("xray.exe")
            info.create_system = 3
            info.external_attr = 0o700 << 16
            archive.writestr(info, b"binary")
        self.assertEqual(self.download("Windows", "amd64", stream.getvalue(), asset), ("xray.exe", b"binary"))

    def test_rejects_wrong_digest_unsupported_archives_and_oversize(self):
        asset = "Xray-linux-64.zip"
        valid = self.make_zip("xray")
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(proxy_runtime.ASSETS, {("Linux", "amd64"): (asset, "0" * 64)}, clear=True), patch.object(
                proxy_runtime.requests, "get", return_value=Response(valid)
            ):
                with self.assertRaisesRegex(ValueError, "BINARY_DOWNLOAD_FAIL"):
                    proxy_runtime.download_binary("Linux", "amd64", Path(directory))
            with self.assertRaisesRegex(ValueError, "BINARY_DOWNLOAD_FAIL"):
                proxy_runtime.download_binary("Windows", "arm64", Path(directory))
            huge = MagicMock()
            huge.raise_for_status.return_value = None
            huge.iter_content.return_value = [b"x" * (proxy_runtime.MAX_ARCHIVE_SIZE + 1)]
            with patch.dict(proxy_runtime.ASSETS, {("Linux", "amd64"): (asset, "0" * 64)}, clear=True), patch.object(
                proxy_runtime.requests, "get", return_value=huge
            ):
                with self.assertRaisesRegex(ValueError, "BINARY_DOWNLOAD_FAIL"):
                    proxy_runtime.download_binary("Linux", "amd64", Path(directory))

    def test_download_network_failure_is_safe(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            proxy_runtime.requests, "get", side_effect=RuntimeError("private release URL")
        ):
            with self.assertRaisesRegex(ValueError, "BINARY_DOWNLOAD_FAIL") as error:
                proxy_runtime.download_binary("Linux", "amd64", Path(directory))
        self.assertNotIn("private", str(error.exception))

    def test_rejects_missing_traversal_and_link_members(self):
        cases = [
            ("tar", self.make_tar("xray")),
            ("zip", self.make_zip("../../xray.exe")),
            ("zip", self.make_zip("xray.exe", symlink=True)),
            ("zip", self.make_zip("nested/xray.exe")),
        ]
        for kind, archive in cases:
            system = "Windows" if kind == "zip" else "Linux"
            asset = "Xray-windows-64.zip" if kind == "zip" else "unsupported.tar.gz"
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory, patch.dict(
                proxy_runtime.ASSETS,
                {(system, "amd64"): (asset, hashlib.sha256(archive).hexdigest())}, clear=True,
            ), patch.object(proxy_runtime.requests, "get", return_value=Response(archive)):
                with self.assertRaisesRegex(ValueError, "BINARY_DOWNLOAD_FAIL"):
                    proxy_runtime.download_binary(system, "amd64", Path(directory))

    def test_rejects_duplicate_and_oversized_root_executable(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("xray", b"first")
            with self.assertWarns(UserWarning):
                archive.writestr("xray", b"second")
        archives = [stream.getvalue(), self.make_zip("xray", b"x" * 11)]
        for archive in archives:
            with self.subTest(size=len(archive)), patch.object(proxy_runtime, "MAX_ARCHIVE_SIZE", 10):
                with self.assertRaisesRegex(ValueError, "^BINARY_DOWNLOAD_FAIL$"):
                    proxy_runtime._read_executable("Xray-linux-64.zip", archive)


class ConfigAndLifecycleTests(unittest.TestCase):
    def outbounds(self, count=5):
        tags = ["a01_p01", "a01_p02", "a01_p03", "a02_p01", "a03_p01"][:count]
        return {tag: {"type": "socks", "server": "proxy.test", "server_port": 1080, "version": "5"}
                for tag in tags}

    def test_builds_one_explicit_route_per_candidate(self):
        config, endpoints = proxy_runtime.build_proxy_config(self.outbounds())
        self.assertEqual(list(endpoints.values()), [f"http://127.0.0.1:{port}" for port in range(18080, 18085)])
        self.assertEqual([item["tag"] for item in config["inbounds"]], [f"in-{tag}" for tag in self.outbounds()])
        self.assertEqual([item["tag"] for item in config["outbounds"]], ["blocked"] + [f"out-{tag}" for tag in self.outbounds()])
        self.assertEqual(config["routing"]["rules"][2], {
            "type": "field", "inboundTag": ["in-a01_p03"], "outboundTag": "out-a01_p03",
        })
        self.assertEqual(config["outbounds"][0], {"protocol": "blackhole", "tag": "blocked", "settings": {}})
        self.assertEqual(config["routing"]["rules"][-1], {
            "type": "field", "network": "tcp,udp", "outboundTag": "blocked",
        })
        self.assertNotIn("freedom", {item["protocol"] for item in config["outbounds"]})
        self.assertTrue(all(item["protocol"] == "http" and item["listen"] == "127.0.0.1"
                            for item in config["inbounds"]))

    def test_renders_protocol_credentials_into_xray_settings(self):
        nodes = {
            "vless": "vless://123e4567-e89b-12d3-a456-426614174000@vless.test:443?security=tls",
            "trojan": "trojan://dummy-password@trojan.test:443",
            "hy2": "hy2://dummy-auth@hy2.test:8443?obfs=salamander&obfs-password=dummy-obfs",
            "socks": "socks5://dummy-user:dummy-password@socks.test:1080",
            "vmess": "vmess://" + b64(json.dumps({"add": "vmess.test", "port": 443,
                "id": "123e4567-e89b-12d3-a456-426614174000", "aid": 0}).encode()),
        }
        config, _ = proxy_runtime.build_proxy_config({tag: proxy_runtime.parse_node_link(link, tag)
                                                     for tag, link in nodes.items()})
        rendered = {item["tag"]: item for item in config["outbounds"][1:]}
        self.assertEqual(rendered["out-vless"]["settings"], {
            "address": "vless.test", "port": 443, "id": "123e4567-e89b-12d3-a456-426614174000", "encryption": "none",
        })
        self.assertEqual(rendered["out-vmess"]["settings"]["security"], "auto")
        self.assertEqual(rendered["out-trojan"]["settings"]["password"], "dummy-password")
        self.assertEqual(rendered["out-socks"]["settings"], {
            "address": "socks.test", "port": 1080, "user": "dummy-user", "pass": "dummy-password",
        })
        self.assertEqual(rendered["out-hy2"]["protocol"], "hysteria")
        self.assertEqual(rendered["out-hy2"]["settings"], {"version": 2, "address": "hy2.test", "port": 8443})
        self.assertEqual(rendered["out-hy2"]["streamSettings"]["hysteriaSettings"], {"version": 2, "auth": "dummy-auth"})
        self.assertEqual(rendered["out-hy2"]["streamSettings"]["udpmasks"], [
            {"type": "salamander", "settings": {"password": "dummy-obfs"}},
        ])

    def test_renders_ws_early_data_without_changing_neutral_fields_or_certificate_policy(self):
        base = "vless://123e4567-e89b-12d3-a456-426614174000@proxy.test:443?security=tls&type=ws"
        for suffix, expected_path in [("&ed=2048&eh=Sec-WebSocket-Protocol&path=%2Fws", "/ws?ed=2048"),
                                      ("&ed=2048&path=%2F%3Fed%3D2048%26route%3DSG", "/?ed=2048&route=SG"),
                                      ("&ed=0", "/?ed=0")]:
            with self.subTest(suffix=suffix):
                node = proxy_runtime.parse_node_link(base + suffix + "&allowInsecure=1&host=cdn.test", "node")
                original = json.loads(json.dumps(node))
                config, _ = proxy_runtime.build_proxy_config({"node": node})
                stream = config["outbounds"][1]["streamSettings"]
                self.assertEqual(stream["wsSettings"], {"path": expected_path, "host": "cdn.test"})
                self.assertEqual(stream["tlsSettings"], {"serverName": "proxy.test", "allowInsecure": True})
                self.assertEqual(node, original)

    def test_renders_reality_and_grpc(self):
        node = proxy_runtime.parse_node_link(
            "vless://123e4567-e89b-12d3-a456-426614174000@proxy.test:443"
            "?security=reality&pbk=public-key&sid=0a&type=grpc&serviceName=svc&fp=firefox", "node")
        config, _ = proxy_runtime.build_proxy_config({"node": node})
        self.assertEqual(config["outbounds"][1]["streamSettings"], {
            "network": "grpc", "grpcSettings": {"serviceName": "svc"}, "security": "reality",
            "realitySettings": {"serverName": "proxy.test", "publicKey": "public-key", "shortId": "0a", "fingerprint": "firefox"},
        })

    def test_rejects_empty_excessive_and_forbidden_outbounds(self):
        with self.assertRaisesRegex(ValueError, "PROXY_START_FAIL"):
            proxy_runtime.build_proxy_config({})
        with patch.object(proxy_runtime, "MAX_ENDPOINTS", 1):
            with self.assertRaisesRegex(ValueError, "PROXY_START_FAIL"):
                proxy_runtime.build_proxy_config(self.outbounds(2))
        with self.assertRaisesRegex(ValueError, "PROXY_START_FAIL"):
            proxy_runtime.build_proxy_config({"a01_p01": {"type": "direct"}})
        with self.assertRaisesRegex(ValueError, "PROXY_START_FAIL"):
            proxy_runtime.build_proxy_config({"a01_p01": {"server": "proxy.test"}})

    def test_rejects_malformed_nested_candidate_data_with_safe_error(self):
        base = self.outbounds(1)["a01_p01"]
        cases = [{"tls": True}, {"transport": True}, {"transport": {"type": "ws", "headers": []}},
                 {"tls": {"enabled": True, "server_name": "proxy.test", "reality": True}},
                 {"transport": {"type": "ws", "early_data_header_name": True}},
                 {"tls": {"enabled": True, "server_name": "proxy.test", "reality": {"enabled": True}, "utls": True}},
                 {"type": "hysteria2", "password": "dummy", "tls": {"enabled": True, "server_name": "proxy.test"}, "obfs": True}]
        for fields in cases:
            with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, "^PROXY_START_FAIL$"):
                proxy_runtime.build_proxy_config({"node": dict(base, **fields)})

    def test_salamander_neutral_password_requires_four_utf8_bytes(self):
        node = {"type": "hysteria2", "server": "hy.test", "server_port": 8443,
                "password": "dummy-auth", "tls": {"enabled": True, "server_name": "hy.test", "insecure": False}}
        for password in ("a", "abc", "\u754c"):
            with self.subTest(password=password), self.assertRaisesRegex(ValueError, "^PROXY_START_FAIL$"):
                proxy_runtime.build_proxy_config({"node": dict(node, obfs={"type": "salamander", "password": password})})
        for password in ("abcd", "\u00e9\u00e9"):
            with self.subTest(password=password):
                config, _ = proxy_runtime.build_proxy_config({
                    "node": dict(node, obfs={"type": "salamander", "password": password})})
                self.assertEqual(config["outbounds"][1]["streamSettings"]["udpmasks"], [
                    {"type": "salamander", "settings": {"password": password}},
                ])

    def test_ws_renderer_preserves_repeated_non_ed_parameters(self):
        base = {"type": "vless", "server": "proxy.test", "server_port": 443,
                "uuid": "123e4567-e89b-12d3-a456-426614174000"}
        for fields, path in [({}, "/ws?route=one&route=two"),
                             ({"max_early_data": 2048}, "/ws?route=one&route=two&ed=2048")]:
            node = dict(base, transport=dict({"type": "ws", "path": "/ws?route=one&route=two"}, **fields))
            with self.subTest(fields=fields):
                config, _ = proxy_runtime.build_proxy_config({"node": node})
                self.assertEqual(config["outbounds"][1]["streamSettings"]["wsSettings"]["path"], path)

    def test_real_local_socket_readiness(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            self.assertTrue(proxy_runtime._ports_ready({"a01_p01": f"http://127.0.0.1:{port}"}))

    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_group_rejects_port_owned_by_unrelated_listener_before_spawn(self, popen, check):
        child = popen.return_value
        child.poll.return_value = None
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with tempfile.TemporaryDirectory() as directory, patch.object(
                proxy_runtime, "FIRST_PORT", port
            ):
                with self.assertRaisesRegex(RuntimeError, "PROXY_START_FAIL"):
                    with proxy_runtime.group_proxy(self.outbounds(1), Path("xray"), Path(directory)):
                        pass
        popen.assert_not_called()

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_group_rechecks_child_after_ports_become_ready(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.side_effect = [None, 1, 1]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "PROXY_START_FAIL"):
                with proxy_runtime.group_proxy(self.outbounds(1), Path("xray"), Path(directory)):
                    pass

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_group_skips_malformed_candidate_before_native_check(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        outbounds = {
            "a01_p01": {"type": "direct"},
            "a01_p02": self.outbounds(1)["a01_p01"],
        }
        with tempfile.TemporaryDirectory() as directory:
            with proxy_runtime.group_proxy(outbounds, Path("xray"), Path(directory)) as endpoints:
                self.assertEqual(endpoints, {"a01_p02": "http://127.0.0.1:18080"})
        self.assertEqual(check.call_count, 2)  # valid candidate, then combined config

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_group_isolates_short_salamander_password_before_native_check(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        outbounds = {
            "a01_p01": {"type": "hysteria2", "server": "hy.test", "server_port": 8443,
                        "password": "dummy-auth", "tls": {"enabled": True, "server_name": "hy.test"},
                        "obfs": {"type": "salamander", "password": "abc"}},
            "a02_p01": self.outbounds(1)["a01_p01"],
        }
        with tempfile.TemporaryDirectory() as directory:
            with proxy_runtime.group_proxy(outbounds, Path("xray"), Path(directory)) as endpoints:
                self.assertEqual(endpoints, {"a02_p01": "http://127.0.0.1:18080"})
        self.assertEqual(check.call_count, 2)
        child.terminate.assert_called_once_with()

    def test_group_rejects_invalid_collection_safely(self):
        for outbounds in (None, {}, []):
            with self.subTest(outbounds=outbounds), self.assertRaisesRegex(RuntimeError, "PROXY_START_FAIL"):
                with proxy_runtime.group_proxy(outbounds, Path("xray"), Path("runtime")):
                    pass

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_group_skips_failed_candidate_and_stops_owned_process(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        check.side_effect = [True, False, True]
        with tempfile.TemporaryDirectory() as directory:
            with proxy_runtime.group_proxy(self.outbounds(2), Path("xray"), Path(directory)) as endpoints:
                self.assertEqual(endpoints, {"a01_p01": "http://127.0.0.1:18080"})
        child.terminate.assert_called_once_with()
        child.wait.assert_called_once_with(timeout=5)
        child.kill.assert_not_called()
        self.assertEqual(check.call_count, 3)  # two candidates, then the combined config

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_group_cleans_up_after_body_exception_and_kills_after_timeout(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired("xray", 5), None]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "browser failed"):
                with proxy_runtime.group_proxy(self.outbounds(1), Path("xray"), Path(directory)):
                    raise RuntimeError("browser failed")
        child.terminate.assert_called_once_with()
        child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_args_list, [call(timeout=5), call(timeout=5)])

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=False)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_group_reports_readiness_timeout_and_early_exit_safely(self, popen, check, ready, available):
        for poll_result in (None, 2):
            child = MagicMock()
            child.poll.return_value = poll_result
            popen.return_value = child
            with self.subTest(poll=poll_result), tempfile.TemporaryDirectory() as directory, patch.object(
                proxy_runtime, "START_TIMEOUT", 0
            ):
                with self.assertRaisesRegex(RuntimeError, "PROXY_START_FAIL"):
                    with proxy_runtime.group_proxy(self.outbounds(1), Path("xray"), Path(directory)):
                        pass

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_windows_process_uses_no_window_and_argument_list(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory, patch.object(proxy_runtime.platform, "system", return_value="Windows"), patch.object(
            proxy_runtime.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True
        ):
            with proxy_runtime.group_proxy(self.outbounds(1), Path("xray.exe"), Path(directory)):
                pass
        _, kwargs = popen.call_args
        self.assertEqual(popen.call_args.args[0][1:3], ["run", "-c"])
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["creationflags"], 0x08000000)
        self.assertIs(kwargs["stdout"], subprocess.DEVNULL)
        self.assertIs(kwargs["stderr"], subprocess.DEVNULL)

    def test_check_outbound_uses_safe_check_command(self):
        completed = MagicMock(returncode=0)
        with tempfile.TemporaryDirectory() as directory, patch.object(
            proxy_runtime.subprocess, "run", return_value=completed
        ) as run, patch.object(proxy_runtime.platform, "system", return_value="Linux"):
            self.assertTrue(proxy_runtime.check_outbound(self.outbounds(1)["a01_p01"], Path("xray"), Path(directory)))
        self.assertEqual(run.call_args.args[0][1:4], ["run", "-test", "-c"])
        self.assertEqual(run.call_args.kwargs["timeout"], 15)
        self.assertFalse(run.call_args.kwargs["shell"])

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime.subprocess, "run", return_value=MagicMock(returncode=0))
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_all_native_commands_disable_inherited_mptcp_without_losing_other_environment(self, popen, run, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        environment = {"GODEBUG": "http2debug=0,multipathtcp=3,panicnil=1", "DUMMY_SETTING": "keep"}
        with tempfile.TemporaryDirectory() as directory, patch.dict(proxy_runtime.os.environ, environment):
            with proxy_runtime.group_proxy(self.outbounds(1), Path("xray"), Path(directory)):
                pass
            self.assertEqual(proxy_runtime.os.environ["GODEBUG"], environment["GODEBUG"])
        for command in run.call_args_list + popen.call_args_list:
            self.assertEqual(command.kwargs["env"]["GODEBUG"], "http2debug=0,panicnil=1,multipathtcp=0")
            self.assertEqual(command.kwargs["env"]["DUMMY_SETTING"], "keep")

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=True)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_start_returns_owned_child_without_stopping_success(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory:
            result_child, endpoints = proxy_runtime.start_proxy(self.outbounds(1), Path("xray"), Path(directory))
        self.assertIs(result_child, child)
        self.assertEqual(endpoints, {"a01_p01": "http://127.0.0.1:18080"})
        child.terminate.assert_not_called()

    @patch.object(proxy_runtime, "_ports_available", return_value=True)
    @patch.object(proxy_runtime, "_ports_ready", return_value=False)
    @patch.object(proxy_runtime, "_check_config", return_value=True)
    @patch.object(proxy_runtime.subprocess, "Popen")
    def test_start_stops_child_on_readiness_failure(self, popen, check, ready, available):
        child = popen.return_value
        child.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory, patch.object(proxy_runtime, "START_TIMEOUT", 0):
            with self.assertRaisesRegex(RuntimeError, "^PROXY_START_FAIL$"):
                proxy_runtime.start_proxy(self.outbounds(1), Path("xray"), Path(directory))
        child.terminate.assert_called_once_with()
        child.wait.assert_called_once_with(timeout=5)


if __name__ == "__main__":
    unittest.main()
