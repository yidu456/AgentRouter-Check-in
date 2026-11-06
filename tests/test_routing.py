import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import routing


PASSWORD_KEY = "password"
ROOT = Path(__file__).resolve().parents[1]


def account(account_id="a01", os_name="ubuntu", proxies=None, **overrides):
    value = {
        "id": account_id,
        "username": f"{account_id}@example.com",
        PASSWORD_KEY: "secret",
        "os": os_name,
        "proxies": proxies if proxies is not None else [{"link": "socks5://proxy.example:1080"}],
    }
    value.update(overrides)
    return value


def config(accounts=None, **overrides):
    value = {"version": 1, "accounts": accounts or [account()]}
    value.update(overrides)
    return value


class ConfigTests(unittest.TestCase):
    def assert_config_fails(self, value):
        raw = value if isinstance(value, str) else json.dumps(value)
        with self.assertRaisesRegex(ValueError, r"^ROUTE_CONFIG_FAIL$"):
            routing.parse_config(raw)

    def test_secret_proxy_order_and_defaults_are_preserved(self):
        raw = config(
            [
                account(
                    **{
                        PASSWORD_KEY: " a:b|c ",
                        "proxies": [
                            {"link": "socks5://one.example:1080#one"},
                            {"link": "socks5://two.example:1080#two"},
                        ],
                    }
                )
            ]
        )

        parsed = routing.parse_config(json.dumps(raw))
        parsed_account = parsed["accounts"][0]

        self.assertEqual(parsed_account[PASSWORD_KEY], " a:b|c ")
        self.assertEqual(parsed_account["proxies"], raw["accounts"][0]["proxies"])
        self.assertEqual(parsed_account["site"], "https://agentrouter.org")
        self.assertEqual(parsed["subscription_url"], "")
        self.assertEqual(parsed["notifications"], {})
        self.assertEqual(
            parsed_account["profile"],
            {
                "viewport": {"width": 1440, "height": 900},
                "screen": {"width": 1440, "height": 900},
                "device_scale_factor": 1,
                "locale": "zh-CN",
                "timezone_id": "Asia/Shanghai",
                "color_scheme": "light",
            },
        )

    def test_json_duplicate_keys_are_rejected(self):
        raw = (
            '{"version":1,"version":1,"accounts":['
            '{"id":"a01","username":"u","password":"p",'
            '"os":"ubuntu","proxies":[{"link":"socks5://p:1"}]}]}'
        )
        self.assert_config_fails(raw)

    def test_invalid_root_shapes_and_size_are_rejected(self):
        cases = [
            "",
            "   ",
            "not json",
            "[]",
            json.dumps({"version": True, "accounts": [account()]}),
            json.dumps({"version": 2, "accounts": [account()]}),
            json.dumps({"version": 1, "accounts": [account()], "extra": 1}),
            " " * (48 * 1024 + 1),
        ]
        for raw in cases:
            with self.subTest(raw=raw[:30]):
                self.assert_config_fails(raw)

    def test_account_schema_requires_exact_nonempty_fields(self):
        required = ("id", "username", PASSWORD_KEY, "os", "proxies")
        for field in required:
            value = account()
            del value[field]
            with self.subTest(missing=field):
                self.assert_config_fails(config([value]))

        invalid_accounts = [
            account(id=7),
            account(account_id="1bad"),
            account(account_id="a" * 33),
            account(username=" "),
            account(**{PASSWORD_KEY: ""}),
            account(os="linux"),
            account(extra=True),
            account(proxies=[]),
        ]
        for value in invalid_accounts:
            with self.subTest(value=value):
                self.assert_config_fails(config([value]))

    def test_duplicate_ids_and_normalized_login_records_are_rejected(self):
        self.assert_config_fails(config([account("a01"), account("a01")]))
        self.assert_config_fails(
            config(
                [
                    account("a01", username="CaseUser", site="HTTPS://EXAMPLE.COM/Path"),
                    account(
                        "a02",
                        username="CaseUser",
                        site="https://example.com/Path",
                        proxies=[{"link": "socks5://other.example:1080"}],
                    ),
                ]
            )
        )
    def test_site_normalizes_scheme_and_host_but_preserves_path_case(self):
        self.assertEqual(
            routing.normalize_site("HTTPS://Example.COM:443/Login/Case"),
            "https://example.com:443/Login/Case",
        )
        self.assertEqual(routing.normalize_site("example.com/API"), "https://example.com/API")
        for value in ("", "ftp://example.com", "https://user@example.com", "https://example.com/#x"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, r"^ROUTE_CONFIG_FAIL$"):
                    routing.normalize_site(value)

    def test_proxy_entries_are_exact_ordered_and_unique_globally(self):
        invalid_proxy_lists = [
            [{}],
            [{"node": "n", "link": "socks5://p:1"}],
            [{"node": " "}],
            [{"link": "http://unsupported.example"}],
            [{"link": "socks5://same.example:1080#a"}, {"link": "socks5://same.example:1080#b"}],
            [{"link": "socks5://proxy.example:1080"}, {"link": "SOCKS5://PROXY.EXAMPLE:1080"}],
            [{"node": "same"}, {"node": "same"}],
        ]
        for proxies in invalid_proxy_lists:
            with self.subTest(proxies=proxies):
                self.assert_config_fails(config([account(proxies=proxies)], subscription_url="https://sub.example/list"))

        self.assert_config_fails(
            config(
                [
                    account("a01", proxies=[{"link": "trojan://u@proxy.example:443#one"}]),
                    account("a02", proxies=[{"link": "trojan://u@proxy.example:443#two"}]),
                ]
            )
        )

    def test_proxy_identity_preserves_credential_path_and_query_case(self):
        distinct = config(
            [
                account("a01", proxies=[{"link": "socks5://User:Secret@proxy.example:1080/Path?q=Case"}]),
                account("a02", proxies=[{"link": "SOCKS5://user:Secret@PROXY.EXAMPLE:1080/path?q=case"}]),
            ]
        )
        parsed = routing.parse_config(json.dumps(distinct))
        self.assertEqual(
            [item["proxies"][0]["link"] for item in parsed["accounts"]],
            [item["proxies"][0]["link"] for item in distinct["accounts"]],
        )
        self.assert_config_fails(
            config(
                [
                    account("a01", proxies=[{"link": "socks5://User:Secret@proxy.example:1080/Path?q=Case"}]),
                    account("a02", proxies=[{"link": "SOCKS5://User:Secret@PROXY.EXAMPLE:1080/Path?q=Case"}]),
                ]
            )
        )

    def test_named_nodes_require_valid_https_subscription(self):
        self.assert_config_fails(config([account(proxies=[{"node": "node-a"}])]))
        for url in ("http://sub.example/list", "https://u@sub.example/list", "https://sub.example/list#secret"):
            with self.subTest(url=url):
                self.assert_config_fails(
                    config([account(proxies=[{"node": "node-a"}])], subscription_url=url)
                )
        parsed = routing.parse_config(
            json.dumps(
                config(
                    [account(proxies=[{"node": "node-a"}])],
                    subscription_url="https://sub.example/list?token=value",
                )
            )
        )
        self.assertEqual(parsed["accounts"][0]["proxies"], [{"node": "node-a"}])

    def test_candidate_count_cannot_exceed_local_port_capacity(self):
        proxies = [
            {"link": "socks5://one.example:1080"},
            {"link": "socks5://two.example:1080"},
        ]
        with patch.object(routing, "MAX_CANDIDATES", 1):
            self.assert_config_fails(config([account(proxies=proxies)]))

    def test_profile_accepts_only_narrow_values_and_fills_defaults(self):
        parsed = routing.parse_config(
            json.dumps(
                config(
                    [
                        account(
                            profile={
                                "viewport": {"width": 800, "height": 600},
                                "device_scale_factor": 2,
                                "locale": "en-US",
                                "timezone_id": "Europe/London",
                                "color_scheme": "dark",
                            }
                        )
                    ]
                )
            )
        )
        profile = parsed["accounts"][0]["profile"]
        self.assertEqual(profile["screen"], {"width": 800, "height": 600})
        self.assertEqual(profile["device_scale_factor"], 2)

        invalid_profiles = [
            None,
            {"unknown": 1},
            {"viewport": {"width": True, "height": 900}},
            {"viewport": {"width": 319, "height": 900}},
            {"viewport": {"width": 900, "height": 900}, "screen": {"width": 800, "height": 900}},
            {"device_scale_factor": 1.5},
            {"locale": "fr-FR"},
            {"timezone_id": "UTC"},
            {"color_scheme": "auto"},
        ]
        for profile in invalid_profiles:
            with self.subTest(profile=profile):
                self.assert_config_fails(config([account(profile=profile)]))

    def test_notifications_are_complete_narrow_and_do_not_read_environment(self):
        webhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-key"
        parsed = routing.parse_config(
            json.dumps(
                config(
                    notifications={
                        "telegram": {"bot_token": "token", "chat_id": "chat"},
                        "wecom": {"webhook_url": webhook},
                    }
                )
            )
        )
        self.assertEqual(parsed["notifications"]["wecom"]["webhook_url"], webhook)

        invalid = [
            None,
            {"telegram": {"bot_token": "token"}},
            {"telegram": {"bot_token": "token", "chat_id": "chat", "extra": 1}},
            {"wecom": {"webhook_url": "https://example.com/?key=x"}},
            {"wecom": {}},
            {"email": {}},
        ]
        for notifications in invalid:
            with self.subTest(notifications=notifications):
                self.assert_config_fails(config(notifications=notifications))

        old_token = os.environ.get("TG_BOT_TOKEN")
        os.environ["TG_BOT_TOKEN"] = "legacy-token"
        try:
            self.assertEqual(routing.parse_config(json.dumps(config()))["notifications"], {})
        finally:
            if old_token is None:
                os.environ.pop("TG_BOT_TOKEN", None)
            else:
                os.environ["TG_BOT_TOKEN"] = old_token

    def test_wecom_webhook_validator_has_no_network_side_effect(self):
        valid = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a%2Fb"
        self.assertTrue(routing.validate_webhook_url(valid))
        invalid = [
            "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
            "https://user@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
            "https://qyapi.weixin.qq.com:444/cgi-bin/webhook/send?key=x",
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x&extra=y",
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x#fragment",
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=",
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assertFalse(routing.validate_webhook_url(value))


class ManifestTests(unittest.TestCase):
    def test_fixed_os_order_sorting_and_three_account_chunks(self):
        accounts = [
            {"id": "u3", "os": "ubuntu", "secret": "x"},
            {"id": "m2", "os": "macos"},
            {"id": "w2", "os": "windows"},
            {"id": "u1", "os": "ubuntu"},
            {"id": "m1", "os": "macos"},
            {"id": "w1", "os": "windows"},
            {"id": "u2", "os": "ubuntu"},
            {"id": "w3", "os": "windows"},
        ]
        manifest = routing.build_manifest(accounts)

        self.assertEqual(
            manifest,
            {
                "version": 1,
                "groups": [
                    {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["u1", "u2", "u3"], "mode": "isolated"},
                    {"group_id": "g02", "os": "windows-2022", "account_ids": ["w1", "w2", "w3"], "mode": "isolated"},
                    {"group_id": "g03", "os": "macos-14", "account_ids": ["m1", "m2"], "mode": "isolated"},
                ],
            },
        )
        public = json.dumps(manifest)
        self.assertNotIn("secret", public)
        self.assertNotIn("username", public)
        self.assertNotIn("proxies", public)

    def test_ten_accounts_are_not_duplicated_or_omitted(self):
        accounts = [{"id": f"a{i:02}", "os": "ubuntu"} for i in range(10, 0, -1)]
        groups = routing.build_manifest(accounts)["groups"]
        self.assertEqual([len(group["account_ids"]) for group in groups], [3, 3, 3, 1])
        self.assertEqual(
            [item for group in groups for item in group["account_ids"]],
            [f"a{i:02}" for i in range(1, 11)],
        )

    def test_manifest_rejects_more_than_256_groups(self):
        accounts = [{"id": f"a{i:04}", "os": "ubuntu"} for i in range(769)]
        with self.assertRaisesRegex(ValueError, r"^ROUTE_CONFIG_FAIL$"):
            routing.build_manifest(accounts)

    def test_reordering_input_does_not_change_manifest(self):
        accounts = [{"id": "b", "os": "macos"}, {"id": "a", "os": "ubuntu"}]
        self.assertEqual(routing.build_manifest(accounts), routing.build_manifest(list(reversed(accounts))))


class PrepareCliTests(unittest.TestCase):
    def run_prepare(self, env_updates):
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            output_path = Path(directory) / "github-output.txt"
            env = os.environ.copy()
            for key in (
                "CHECKIN_CONFIG",
                "CHECKIN_MODE",
                "GITHUB_ACTIONS",
                "ACCOUNTS",
                "USERNAME",
                "PASSWORD",
            ):
                env.pop(key, None)
            env.update(env_updates)
            env["GITHUB_OUTPUT"] = str(output_path)
            result = subprocess.run(
                [sys.executable, "routing.py", "prepare", "--manifest", str(manifest_path)],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
            output = output_path.read_text(encoding="utf-8") if output_path.exists() else ""
            return result, manifest, output

    def test_isolated_prepare_writes_only_public_manifest_and_matrix(self):
        secret = "do-not-leak-secret"
        raw = config([account(**{PASSWORD_KEY: secret})])
        result, manifest, output = self.run_prepare({"CHECKIN_CONFIG": json.dumps(raw)})

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(manifest, routing.build_manifest(routing.parse_config(json.dumps(raw))["accounts"]))
        self.assertEqual(json.loads(output.removeprefix("matrix=").strip()), {"include": manifest["groups"]})
        self.assertNotIn(secret, result.stdout + result.stderr + output + json.dumps(manifest))

    def test_github_empty_config_emits_one_legacy_group_with_stable_ids(self):
        result, manifest, output = self.run_prepare(
            {
                "CHECKIN_CONFIG": "",
                "GITHUB_ACTIONS": "true",
                "ACCOUNTS": (
                    "https://one.example|user1:pass:with:colons\n"
                    "user2:secret\nuser3:secret\nuser4:secret"
                ),
            }
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            manifest,
            {
                "version": 1,
                "groups": [
                    {
                        "group_id": "g01",
                        "os": "ubuntu-24.04",
                        "account_ids": ["legacy001", "legacy002", "legacy003", "legacy004"],
                        "mode": "legacy",
                    }
                ],
            },
        )
        self.assertEqual(json.loads(output.removeprefix("matrix=").strip()), {"include": manifest["groups"]})
        self.assertNotIn("pass:with:colons", result.stdout + result.stderr + output)

    def test_legacy_username_secret_fallback_gets_one_id(self):
        result, manifest, _ = self.run_prepare(
            {"GITHUB_ACTIONS": "true", "USERNAME": "unit-user", "PASSWORD": "unit:password"}
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(manifest["groups"][0]["account_ids"], ["legacy001"])

    def test_empty_local_or_explicit_isolated_config_fails_safely(self):
        cases = [
            {"CHECKIN_CONFIG": ""},
            {"CHECKIN_CONFIG": "", "CHECKIN_MODE": "isolated", "GITHUB_ACTIONS": "true"},
            {"CHECKIN_CONFIG": json.dumps(config()), "CHECKIN_MODE": "legacy"},
            {"CHECKIN_CONFIG": "credential-marker-not-json"},
        ]
        for env in cases:
            with self.subTest(env=env):
                result, manifest, output = self.run_prepare(env)
                self.assertEqual(result.returncode, 1)
                self.assertIsNone(manifest)
                self.assertEqual(output, "")
                self.assertEqual(result.stderr.strip(), "ROUTE_CONFIG_FAIL")
                self.assertNotIn("credential-marker-not-json", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
