import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import routing


ROOT = Path(__file__).resolve().parents[1]


def account(account_id, **overrides):
    value = {
        "id": account_id,
        "username": f"{account_id}@example.com",
        routing.PASSWORD_KEY: "example:secret|value",
        "proxies": [{"link": f"socks5://{account_id}.example.com:1080"}],
    }
    value.update(overrides)
    return value


def grouped(**overrides):
    value = {"version": 2, "groups": {"ubuntu": {"accounts": [account("u01")]}}}
    value.update(overrides)
    return value


class OsGroupTests(unittest.TestCase):
    def parse(self, value):
        return routing.parse_config(json.dumps(value))

    def assert_config_fails(self, value):
        with self.assertRaisesRegex(ValueError, r"^ROUTE_CONFIG_FAIL$"):
            self.parse(value)

    def test_three_outer_groups_inherit_os_and_keep_multiple_account_settings(self):
        value = grouped(groups={
            "macos": {"accounts": [account("m02"), account("m01")]},
            "ubuntu": {"accounts": [account("u02", **{
                routing.PASSWORD_KEY: " a:b|c ",
                "proxies": [{"link": "socks5://primary.example:1080"},
                            {"link": "socks5://backup.example:1080"}],
                "profile": {"viewport": {"width": 800, "height": 600}, "locale": "en-US"},
            }), account("u01")]},
            "windows": {"accounts": [account("w02"), account("w01")]},
        })
        parsed = self.parse(value)
        by_id = {item["id"]: item for item in parsed["accounts"]}

        self.assertEqual(len(by_id), 6)
        self.assertEqual({key: item["os"] for key, item in by_id.items()}, {
            "u01": "ubuntu", "u02": "ubuntu", "m01": "macos", "m02": "macos",
            "w01": "windows", "w02": "windows",
        })
        self.assertEqual(by_id["u02"][routing.PASSWORD_KEY], " a:b|c ")
        self.assertEqual(by_id["u02"]["proxies"], [
            {"link": "socks5://primary.example:1080"}, {"link": "socks5://backup.example:1080"},
        ])
        self.assertEqual(by_id["u02"]["profile"]["screen"], {"width": 800, "height": 600})
        self.assertEqual(by_id["u02"]["profile"]["locale"], "en-US")
        self.assertEqual(by_id["u01"]["profile"]["locale"], "zh-CN")

    def test_grouped_format_normalizes_to_existing_v1_runtime_contract(self):
        value = grouped(
            subscription_url="https://subscription.example/sub",
            notifications={"telegram": {"bot_token": "example", "chat_id": "123"}},
        )
        legacy_account = account("u01", os="ubuntu")
        old = {"version": 1, "accounts": [legacy_account],
               "subscription_url": value["subscription_url"], "notifications": value["notifications"]}
        parsed = self.parse(value)

        self.assertEqual(parsed, self.parse(old))
        self.assertEqual(self.parse(parsed), parsed)
        self.assertNotIn("groups", parsed)

    def test_omitted_and_empty_known_groups_do_not_create_jobs(self):
        value = grouped(groups={"windows": {"accounts": []},
                                "macos": {"accounts": [account("m01")]}})
        self.assertEqual(routing.build_manifest(self.parse(value)["accounts"]), {
            "version": 1, "groups": [{"group_id": "g01", "os": "macos-15",
                                       "account_ids": ["m01"], "mode": "isolated"}],
        })

    def test_more_than_three_accounts_keep_existing_manifest_chunks(self):
        value = grouped(groups={"ubuntu": {"accounts": [account(f"u{i:02}") for i in range(4, 0, -1)]}})
        self.assertEqual(routing.build_manifest(self.parse(value)["accounts"]), {
            "version": 1, "groups": [
                {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["u01", "u02", "u03"], "mode": "isolated"},
                {"group_id": "g02", "os": "ubuntu-24.04", "account_ids": ["u04"], "mode": "isolated"},
            ],
        })

    def test_versions_cannot_mix_account_and_group_shapes(self):
        invalid = [
            grouped(version=True), grouped(version="2"), grouped(version=2.0), grouped(version=3),
            grouped(accounts=[account("other", os="ubuntu")]), grouped(version=1),
            {"version": 2, "accounts": [account("u01", os="ubuntu")]},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assert_config_fails(value)

    def test_group_schema_rejects_unknown_os_and_empty_total_accounts(self):
        invalid_groups = [
            None, [], {}, {"ubuntu": {"accounts": []}}, {"linux": {"accounts": [account("u01")]}},
            {"Ubuntu": {"accounts": [account("u01")]}}, {"ubuntu": [account("u01")]},
            {"ubuntu": {}}, {"ubuntu": {"accounts": None}}, {"ubuntu": {"accounts": {}}},
            {"ubuntu": {"accounts": [account("u01")], "profile": {}}},
        ]
        for groups in invalid_groups:
            with self.subTest(groups=groups):
                self.assert_config_fails(grouped(groups=groups))

    def test_account_cannot_repeat_or_override_inherited_os(self):
        for os_name in ("ubuntu", "macos", None):
            with self.subTest(os_name=os_name):
                self.assert_config_fails(grouped(groups={"ubuntu": {
                    "accounts": [account("u01", os=os_name)],
                }}))

    def test_duplicate_ids_logins_and_proxy_bindings_fail_across_os_groups(self):
        values = [
            account("u01", username="other@example.com", proxies=[{"link": "socks5://other.example:1080"}]),
            account("m01", username="u01@example.com"),
            account("m01", proxies=[{"link": "SOCKS5://U01.EXAMPLE.COM:1080#different-label"}]),
        ]
        for other in values:
            with self.subTest(other=other):
                self.assert_config_fails(grouped(groups={"ubuntu": {"accounts": [account("u01")]},
                                                        "macos": {"accounts": [other]}}))

    def test_grouped_accounts_reuse_strict_profile_and_notification_validation(self):
        self.assert_config_fails(grouped(groups={"ubuntu": {"accounts": [account("u01", profile=None)]}}))
        self.assert_config_fails(grouped(notifications={"wecom": {"webhook_url": "https://example.com/?key=x"}}))
        value = grouped()
        del value["groups"]["ubuntu"]["accounts"][0][routing.PASSWORD_KEY]
        self.assert_config_fails(value)

    def test_random_capacity_is_global_not_reset_per_os_group(self):
        value = grouped(subscription_url="https://subscription.example/sub", groups={
            "ubuntu": {"accounts": [account("u01", proxies=[{"random": 2}])]},
            "macos": {"accounts": [account("m01", proxies=[{"random": 2}])]},
        })
        self.assertEqual([item["proxies"] for item in self.parse(value)["accounts"]],
                         [[{"random": 2}], [{"random": 2}]])
        with patch.object(routing, "MAX_CANDIDATES", 3):
            self.assert_config_fails(value)
        value.pop("subscription_url")
        self.assert_config_fails(value)

    def test_duplicate_group_keys_are_rejected_without_secret_details(self):
        raw = '{"version":2,"groups":{"ubuntu":{"accounts":[]},"ubuntu":{"accounts":[]}}}'
        with self.assertRaisesRegex(ValueError, r"^ROUTE_CONFIG_FAIL$"):
            routing.parse_config(raw)

    def test_optional_management_api_credential_preserved_in_both_config_versions(self):
        credential = {"access_token": "example-management-token", "user_id": 42}
        for value in (
            grouped(groups={"ubuntu": {"accounts": [account("u01", api=credential)]}}),
            {"version": 1, "accounts": [account("u01", os="ubuntu", api=credential)]},
        ):
            with self.subTest(version=value["version"]):
                parsed = self.parse(value)
                self.assertEqual(parsed["accounts"][0]["api"], credential)
                manifest = routing.build_manifest(parsed["accounts"])
                self.assertNotIn("example-management-token", json.dumps(manifest))
                self.assertNotIn("access_token", json.dumps(manifest))
        self.assertNotIn("api", self.parse(grouped())["accounts"][0])

    def test_optional_api_rejects_wrong_shapes_ids_and_unsafe_header_tokens(self):
        invalid = [None, {}, {"access_token": "token"}, {"access_token": "token", "user_id": 42, "url": "https://example.com"}]
        invalid.extend({"access_token": token, "user_id": 42}
                       for token in (None, 123, "", " token", "token ", "two words", "token\r\ninjected:1", "token\x7f", "\u4e2d", "x" * 4097))
        invalid.extend({"access_token": "token", "user_id": user_id}
                       for user_id in (None, True, 0, -1, "42", 1.5, 2 ** 53))
        for credential in invalid:
            with self.subTest(credential=credential):
                self.assert_config_fails(grouped(groups={"ubuntu": {"accounts": [account("u01", api=credential)]}}))

    def test_optional_api_accepts_header_token_and_user_id_upper_bounds(self):
        credential = {"access_token": "x" * 4096, "user_id": 2 ** 53 - 1}
        value = grouped(groups={"ubuntu": {"accounts": [account("u01", api=credential)]}})
        self.assertEqual(self.parse(value)["accounts"][0]["api"], credential)

    def test_grouped_prepare_outputs_credential_free_existing_manifest(self):
        value = grouped(groups={"ubuntu": {"accounts": [account("u01")]},
                                "windows": {"accounts": [account("w01")]}})
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            env = os.environ.copy()
            env["CHECKIN_CONFIG"] = json.dumps(value)
            env.pop("CHECKIN_MODE", None)
            result = subprocess.run([sys.executable, "routing.py", "prepare", "--manifest", str(manifest_path)],
                                    cwd=ROOT, env=env, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual([item["account_ids"] for item in manifest["groups"]], [["u01"], ["w01"]])
        public = result.stdout + result.stderr + json.dumps(manifest)
        self.assertNotIn("example:secret|value", public)
        self.assertNotIn("example.com", public)
        self.assertNotIn("username", public)


if __name__ == "__main__":
    unittest.main()
