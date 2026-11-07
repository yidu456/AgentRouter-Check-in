import base64
import copy
import hashlib
import hmac
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import subscription_pool


URL = "https://subscription.example/nodes"
SEED = "0123456789abcdef0123456789abcdef"
MAX_BYTES = 4 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]


def node(number):
    return {"type": "socks", "server": f"node{number}.example",
            "server_port": 1080, "version": "5"}


def link(number, name=""):
    return f"socks5://node{number}.example:1080" + (f"#{name}" if name else "")


def account(account_id, proxies=None, os_name="ubuntu"):
    return {"id": account_id, "username": f"{account_id}@example.com",
            "password": "dummy:secret", "os": os_name,
            "proxies": proxies if proxies is not None else [{"random": 1}]}


def config(accounts=None):
    return {"version": 1, "subscription_url": URL,
            "accounts": accounts if accounts is not None else [account("a")]}


def response_for(raw=None, chunks=None):
    response = Mock()
    response.headers = {}
    response.iter_content.return_value = chunks if chunks is not None else [raw]
    return response


class PoolFetchTests(unittest.TestCase):
    def load(self, raw, require_names=False):
        response = response_for(raw)
        with patch("requests.get", return_value=response) as get:
            result = subscription_pool.load_pool(URL, require_names=require_names)
        get.assert_called_once_with(URL, stream=True, timeout=30)
        response.close.assert_called_once_with()
        return result

    def test_unnamed_renamed_duplicates_and_order_do_not_change_pool(self):
        first_names, first = self.load(
            (link(2, "same") + "\n" + link(1) + "\n" + link(2, "same") + "\n").encode()
        )
        second_names, second = self.load(
            (link(1, "renamed") + "\n" + link(2, "other") + "\n" + link(1, "alias")).encode()
        )
        self.assertEqual(first, [node(1), node(2)])
        self.assertEqual(first, second)
        self.assertEqual(first_names, {})
        self.assertEqual(set(second_names), {"renamed", "other", "alias"})
        self.assertTrue(all("tag" not in outbound for outbound in first))

    def test_base64_subscription_and_unsupported_nodes_are_handled(self):
        raw = ("ss://unsupported.example:443#unsupported\n" + link(3, "usable") +
               "\nvless://not-a-uuid@broken.example:443#broken").encode()
        names, nodes = self.load(base64.b64encode(raw))
        self.assertEqual(names, {"usable": link(3, "usable")})
        self.assertEqual(nodes, [node(3)])

    def test_websocket_default_and_early_data_aliases_are_deduplicated(self):
        from proxy_runtime import build_proxy_config, parse_node_link

        base = "vless://123e4567-e89b-12d3-a456-426614174000@ws.example:443?type=ws"
        _, nodes = self.load((base + "#one\n" + base + "&path=%2F#two").encode())
        self.assertEqual(len(nodes), 1)
        _, nodes = self.load((base + "&ed=2048&eh=Sec-WebSocket-Protocol#one\n" +
                              base + "&path=%2F%3Fed%3D2048#two").encode())
        self.assertEqual(len(nodes), 1)
        original = parse_node_link(base + "&ed=2048&eh=Sec-WebSocket-Protocol#one", "subscription")
        self.assertEqual(build_proxy_config({"candidate": nodes[0]}),
                         build_proxy_config({"candidate": original}))

    def test_all_supported_protocols_survive_neutral_validation(self):
        payload = {"v": "2", "ps": "vmess", "add": "vmess.example", "port": "443",
                   "id": "123e4567-e89b-12d3-a456-426614174000", "aid": "0", "net": "tcp", "tls": ""}
        vmess = "vmess://" + base64.b64encode(json.dumps(payload).encode()).decode()
        lines = [
            vmess,
            "vless://123e4567-e89b-12d3-a456-426614174000@vless.example:443?security=reality&pbk=dummy-key&sid=0a0b#vless",
            "trojan://dummy-secret@trojan.example:443?type=grpc&serviceName=rpc#trojan",
            "hy2://dummy-secret@hy2.example:443?obfs=salamander&obfs-password=dummy-obfs#hy2",
            link(1, "socks"),
        ]
        names, nodes = self.load("\n".join(lines).encode())
        self.assertEqual(set(names), {"vmess", "vless", "trojan", "hy2", "socks"})
        self.assertEqual({item["type"] for item in nodes}, {"vmess", "vless", "trojan", "hysteria2", "socks"})

    def test_duplicate_names_fail_strictly_even_for_unsupported_entries(self):
        for raw in (
            link(1, "dup") + "\n" + link(2, "dup"),
            "ss://unsupported.example:443#dup\n" + link(2, "dup"),
        ):
            response = response_for(raw.encode())
            with patch("requests.get", return_value=response):
                with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
                    subscription_pool.load_pool(URL, require_names=True)
            response.close.assert_called_once_with()

    def test_malformed_empty_and_unsupported_subscriptions_fail_safely(self):
        for raw in (b"", b"\xff", b"{}", b"proxies:\n- name: dummy",
                    b"not base64!", b"ss://unsupported.example:443"):
            response = response_for(raw)
            with patch("requests.get", return_value=response):
                with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
                    subscription_pool.load_pool(URL)
            response.close.assert_called_once_with()

    def test_exact_limit_is_accepted_but_larger_stream_is_closed(self):
        prefix = (link(1) + "\n#").encode()
        raw = prefix + b"x" * (MAX_BYTES - len(prefix))
        self.assertEqual(self.load(raw)[1], [node(1)])
        response = response_for(chunks=[raw, b"x"])
        with patch("requests.get", return_value=response):
            with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
                subscription_pool.load_pool(URL)
        response.close.assert_called_once_with()

    def test_http_and_stream_failures_always_close_without_leaking_details(self):
        for operation in ("raise_for_status", "iter_content"):
            response = response_for(b"")
            getattr(response, operation).side_effect = RuntimeError("private-url-secret")
            with patch("requests.get", return_value=response):
                with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
                    subscription_pool.load_pool(URL)
            response.close.assert_called_once_with()

    def test_close_failure_is_redacted_too(self):
        response = response_for(link(1).encode())
        response.close.side_effect = RuntimeError("private-subscription-secret")
        with patch("requests.get", return_value=response):
            with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
                subscription_pool.load_pool(URL)

    def test_invalid_url_is_rejected_before_fetch(self):
        for url in ("http://subscription.example/x", "https://user:secret@subscription.example/x",
                    "https://subscription.example/x#secret", "https://subscription.example:0/x",
                    None, " https://subscription.example/x"):
            with patch("requests.get", side_effect=AssertionError("must not fetch")):
                with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
                    subscription_pool.load_pool(url)


class AllocationTests(unittest.TestCase):
    def assert_pool_fails(self, call, *args, **kwargs):
        with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
            call(*args, **kwargs)

    def test_has_random_checks_all_accounts_and_entries(self):
        self.assertFalse(subscription_pool.has_random([account("a", [{"link": link(1)}])]))
        self.assertTrue(subscription_pool.has_random([
            account("a", [{"link": link(1)}]),
            account("b", [{"link": link(2)}, {"random": 2}]),
        ]))

    def test_global_hmac_allocation_expands_in_place_without_reuse_or_mutation(self):
        value = config([
            account("z", [{"random": 1}], "windows"),
            account("a", [{"random": 1}, {"node": "fixed"}, {"random": 2}], "macos"),
            account("m", [{"link": link(2, "direct")}, {"random": 1}], "ubuntu"),
        ])
        names = {"fixed": link(1, "fixed")}
        nodes = [node(number) for number in range(1, 8)]
        original = copy.deepcopy((value, names, nodes))
        plan = subscription_pool.make_plan(value, names, nodes, seed=SEED)
        result = subscription_pool.resolve_random_accounts(value, plan, names, nodes)
        by_id = {item["id"]: item for item in result}
        eligible = [node(number) for number in range(3, 8)]
        ranked = sorted(eligible, key=lambda item: hmac.new(
            bytes.fromhex(SEED),
            json.dumps(item, sort_keys=True, separators=(",", ":")).encode(),
            hashlib.sha256,
        ).digest())
        self.assertEqual(by_id["a"]["proxies"], [
            {"outbound": ranked[0]}, {"link": link(1, "fixed")},
            {"outbound": ranked[1]}, {"outbound": ranked[2]},
        ])
        self.assertEqual(by_id["m"]["proxies"], [
            {"link": link(2, "direct")}, {"outbound": ranked[3]},
        ])
        self.assertEqual(by_id["z"]["proxies"], [{"outbound": ranked[4]}])
        self.assertEqual((value, names, nodes), original)
        self.assertIsNot(result, value["accounts"])
        self.assertEqual([item["id"] for item in result], ["z", "a", "m"])
        by_id["a"]["proxies"][0]["outbound"]["server"] = "changed.example"
        self.assertEqual((value, names, nodes), original)

    def test_reordered_accounts_pool_tags_and_duplicate_nodes_are_stable(self):
        value = config([account("z", os_name="macos"), account("a", os_name="windows")])
        nodes = [node(1), node(2), node(3)]
        plan = subscription_pool.make_plan(value, {}, nodes, seed=SEED)
        reordered = copy.deepcopy(value)
        reordered["accounts"].reverse()
        tagged = [{**node(3), "tag": "renamed"}, node(2), node(1), node(1)]
        self.assertEqual(subscription_pool.make_plan(reordered, {}, tagged, seed=SEED), plan)
        first = subscription_pool.resolve_random_accounts(value, plan, {}, nodes)
        second = subscription_pool.resolve_random_accounts(reordered, plan, {}, tagged)
        self.assertEqual({item["id"]: item for item in first}, {item["id"]: item for item in second})

    def test_unused_names_and_random_only_renames_do_not_change_plan(self):
        value, nodes = config(), [node(1), node(2)]
        first = subscription_pool.make_plan(value, {"old": link(1, "old")}, nodes, seed=SEED)
        second = subscription_pool.make_plan(value, {"new": link(1, "new")}, nodes, seed=SEED)
        self.assertEqual(first, second)

    def test_swapped_fixed_name_bindings_change_plan_and_reject_old_plan(self):
        value = config([
            account("z", [{"node": "fixed-b"}], "windows"),
            account("a", [{"random": 1}, {"node": "fixed-a"}], "macos"),
        ])
        nodes = [node(1), node(2), node(3)]
        names = {"fixed-a": link(1, "fixed-a"), "fixed-b": link(2, "fixed-b")}
        swapped = {"fixed-a": link(2, "fixed-a"), "fixed-b": link(1, "fixed-b")}
        plan = subscription_pool.make_plan(value, names, nodes, seed=SEED)
        with self.subTest(operation="make"):
            self.assertNotEqual(subscription_pool.make_plan(value, swapped, nodes, seed=SEED), plan)
        with self.subTest(operation="resolve"):
            self.assert_pool_fails(subscription_pool.resolve_random_accounts, value, plan, swapped, nodes)

    def test_unused_name_mapping_swap_and_fixed_link_alias_keep_identity_plan_stable(self):
        nodes = [node(1), node(2), node(3)]
        names = {"fixed-a": link(1, "old"), "fixed-b": link(2, "other")}
        swapped = {"fixed-a": link(2, "new"), "fixed-b": link(1, "renamed")}
        first = subscription_pool.make_plan(config(), names, nodes, seed=SEED)
        self.assertEqual(subscription_pool.make_plan(config(), swapped, nodes, seed=SEED), first)
        value = config([account("a", [{"random": 1}, {"node": "fixed-a"}])])
        plan = subscription_pool.make_plan(value, names, nodes, seed=SEED)
        aliases = {"fixed-a": "socks://NODE1.EXAMPLE:1080#renamed", "fixed-b": link(2, "renamed")}
        self.assertEqual(subscription_pool.make_plan(value, aliases, nodes, seed=SEED), plan)

    def test_fixed_alias_and_host_case_are_excluded_by_identity(self):
        value = config([account("a", [{"random": 1}, {"link": "socks://NODE1.EXAMPLE:1080#renamed"}])])
        nodes = [node(1), node(2)]
        plan = subscription_pool.make_plan(value, {}, nodes, seed=SEED)
        result = subscription_pool.resolve_random_accounts(value, plan, {}, nodes)
        self.assertEqual(result[0]["proxies"][0], {"outbound": node(2)})

    def test_fixed_websocket_alias_is_reserved_before_random_selection(self):
        base = "vless://123e4567-e89b-12d3-a456-426614174000@ws.example:443?type=ws"
        response = response_for((base + "&path=%2F#pool\n" + link(2)).encode())
        with patch("requests.get", return_value=response):
            names, nodes = subscription_pool.load_pool(URL)
        value = config([account("a", [{"random": 1}, {"link": base}])])
        plan = subscription_pool.make_plan(value, names, nodes, seed=SEED)
        result = subscription_pool.resolve_random_accounts(value, plan, names, nodes)
        self.assertEqual(result[0]["proxies"][0], {"outbound": node(2)})
        self.assert_pool_fails(subscription_pool.make_plan, value, names,
                               [item for item in nodes if item["type"] == "vless"], seed=SEED)

    def test_shortage_counts_deduplicated_pool_and_all_fixed_reservations(self):
        cases = [
            (config([account("a", [{"random": 2}])]), {}, [node(1), node(1)]),
            (config([account("a"), account("b", [{"link": link(1)}], "macos")]), {}, [node(1)]),
            (config([account("a", [{"random": 1}, {"node": "fixed"}])]),
             {"fixed": link(1, "fixed")}, [node(1)]),
        ]
        for value, names, nodes in cases:
            with self.subTest(value=value):
                self.assert_pool_fails(subscription_pool.make_plan, value, names, nodes, seed=SEED)

    def test_unsupported_fixed_link_missing_name_and_duplicate_fixed_identity_fail_closed(self):
        cases = [
            (config([account("a", [{"random": 1}, {"link": "vless://invalid@broken.example:443"}])]), {}),
            (config([account("a", [{"random": 1}, {"node": "missing"}])]), {}),
            (config([account("a", [{"random": 1}, {"node": "same"}]),
                     account("b", [{"link": link(1)}])]), {"same": link(1, "same")}),
            (config([account("a", [{"random": 1}, {"node": "one"}]),
                     account("b", [{"node": "two"}])]),
             {"one": link(1, "one"), "two": link(1, "two")}),
        ]
        for value, names in cases:
            with self.subTest(value=value):
                self.assert_pool_fails(subscription_pool.make_plan, value, names, [node(1), node(2)], seed=SEED)

    def test_plan_contains_only_generated_seed_and_keyed_fingerprint(self):
        value = config()
        plan = subscription_pool.make_plan(value, {}, [node(1)])
        self.assertEqual(set(plan), {"seed", "fingerprint"})
        self.assertRegex(plan["seed"], "^[0-9a-f]{32}$")
        self.assertRegex(plan["fingerprint"], "^[0-9a-f]{64}$")
        self.assertNotIn("example", json.dumps(plan))
        self.assertNotIn("secret", json.dumps(plan))
        self.assertNotEqual(plan, subscription_pool.make_plan(value, {}, [node(1)]))

    def test_fingerprint_is_hmac_keyed_by_complete_validated_config(self):
        import routing

        value = config([account("a", [{"random": 1}, {"link": link(1)}])])
        normalized = routing.parse_config(json.dumps(value))
        canonical = lambda item: json.dumps(item, sort_keys=True, ensure_ascii=True,
                                             separators=(",", ":")).encode()
        message = {"seed": SEED, "pool": [canonical(node(2)).decode()],
                   "reserved": [canonical(node(1)).decode()],
                   "fixed": [["a", 1, canonical(node(1)).decode()]]}
        expected = hmac.new(canonical(normalized), canonical(message), hashlib.sha256).hexdigest()
        plan = subscription_pool.make_plan(value, {}, [node(2)], seed=SEED)
        self.assertEqual(plan["fingerprint"], expected)

    def test_seed_fingerprint_config_and_pool_tampering_is_rejected(self):
        value, nodes = config(), [node(1), node(2)]
        plan = subscription_pool.make_plan(value, {}, nodes, seed=SEED)
        for key in plan:
            tampered = dict(plan)
            tampered[key] = ("1" if plan[key][0] != "1" else "2") + plan[key][1:]
            self.assert_pool_fails(subscription_pool.resolve_random_accounts, value, tampered, {}, nodes)
        self.assert_pool_fails(subscription_pool.resolve_random_accounts, value, plan, {}, [node(1)])
        mutations = [
            lambda changed: changed["accounts"][0].update(password="another:secret"),
            lambda changed: changed["accounts"][0].update(os="windows"),
            lambda changed: changed["accounts"][0].update(site="https://other.example"),
            lambda changed: changed["accounts"][0].update(profile={"locale": "en-US"}),
            lambda changed: changed.update(subscription_url="https://other.example/nodes"),
            lambda changed: changed.update(notifications={"telegram": {"bot_token": "dummy-token", "chat_id": "dummy"}}),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(value)
            mutate(changed)
            new_plan = subscription_pool.make_plan(changed, {}, nodes, seed=SEED)
            self.assertNotEqual(plan["fingerprint"], new_plan["fingerprint"])
            self.assert_pool_fails(subscription_pool.resolve_random_accounts, changed, plan, {}, nodes)

    def test_reserved_link_outside_pool_is_still_bound_to_fingerprint(self):
        value = config([account("a", [{"random": 1}, {"link": link(8)}])])
        nodes = [node(1)]
        plan = subscription_pool.make_plan(value, {}, nodes, seed=SEED)
        changed = copy.deepcopy(value)
        changed["accounts"][0]["proxies"][1] = {"link": link(9)}
        self.assert_pool_fails(subscription_pool.resolve_random_accounts, changed, plan, {}, nodes)

    def test_bad_plan_shapes_and_seeds_are_rejected(self):
        valid = {"seed": SEED, "fingerprint": "0" * 64}
        for plan in (None, [], {}, {"seed": SEED}, {**valid, "nodes": []},
                     {**valid, "seed": SEED.upper()}, {**valid, "fingerprint": "G" * 64},
                     {**valid, "seed": True}, {**valid, "fingerprint": 1}):
            self.assert_pool_fails(subscription_pool.validate_plan, plan)
        subscription_pool.validate_plan(valid)
        for seed in ("", "1" * 31, "1" * 33, SEED.upper(), True, 5, b"0" * 32):
            self.assert_pool_fails(subscription_pool.make_plan, config(), {}, [node(1)], seed=seed)

    def test_invalid_config_and_node_shapes_have_one_safe_failure(self):
        for value in (None, {}, {**config(), "version": True}, config([account("a", [{"random": True}])]),
                      config([account("a", [{"random": 0}])]), {**config(), "extra": "secret"}):
            self.assert_pool_fails(subscription_pool.make_plan, value, {}, [node(1)], seed=SEED)
        for nodes in (None, {}, [None], [{"type": "direct"}], [{**node(1), "server_port": True}],
                      [{**node(1), "extra": "secret"}], [{**node(1), "server": "bad\nsecret"}]):
            self.assert_pool_fails(subscription_pool.make_plan, config(), {}, nodes, seed=SEED)
        self.assert_pool_fails(subscription_pool.make_plan, config(), {"x": link(2)}, [node(1)], seed=SEED)

    def test_normalized_config_can_be_revalidated(self):
        import routing

        normalized = routing.parse_config(json.dumps(config()))
        plan = subscription_pool.make_plan(normalized, {}, [node(1)], seed=SEED)
        self.assertEqual(subscription_pool.resolve_random_accounts(normalized, plan, {}, [node(1)])[0]["proxies"],
                         [{"outbound": node(1)}])

    def test_grouped_normalized_os_does_not_inflate_raw_config_limit(self):
        import routing

        accounts = [{"id": f"a{number:03}", "username": f"u{number:03}",
                     "password": "p", "proxies": [{"random": 1}]} for number in range(600)]
        value = {"version": 2, "subscription_url": URL,
                 "groups": {"ubuntu": {"accounts": accounts}}}
        raw = json.dumps(value, separators=(",", ":"))
        self.assertLess(len(raw.encode("utf-8")), routing.MAX_CONFIG_BYTES)
        normalized = routing.parse_config(raw)
        # Even after removing ordinary defaults, inherited OS exceeds the raw budget.
        expanded = copy.deepcopy(normalized)
        for item in expanded["accounts"]:
            item.pop("profile")
            item.pop("site")
        self.assertGreater(len(json.dumps(expanded, separators=(",", ":")).encode("utf-8")),
                           routing.MAX_CONFIG_BYTES)
        nodes = [node(number) for number in range(600)]
        plan = subscription_pool.make_plan(normalized, {}, nodes, seed=SEED)
        self.assertEqual(plan, subscription_pool.make_plan(value, {}, nodes, seed=SEED))
        result = subscription_pool.resolve_random_accounts(normalized, plan, {}, nodes)
        self.assertEqual(len(result), 600)
        self.assertEqual(len({item["proxies"][0]["outbound"]["server"] for item in result}), 600)

    def test_grouped_external_json_still_enforces_raw_size_limit(self):
        import routing

        value = {"version": 2, "subscription_url": URL, "groups": {"ubuntu": {"accounts": [
            {"id": "a", "username": "u", "password": "p", "proxies": [{"random": 1}]},
        ]}}}
        raw = json.dumps(value)
        oversized = raw + " " * (routing.MAX_CONFIG_BYTES + 1 - len(raw.encode("utf-8")))
        with self.assertRaisesRegex(ValueError, r"^ROUTE_CONFIG_FAIL$"):
            routing.parse_config(oversized)

    def test_normalized_defaults_and_unicode_do_not_inflate_raw_config_limit(self):
        import routing

        value = config([account(f"a{number:03}") for number in range(200)])
        normalized = routing.parse_config(json.dumps(value))
        nodes = [node(number) for number in range(200)]
        self.assertEqual(subscription_pool.make_plan(normalized, {}, nodes, seed=SEED),
                         subscription_pool.make_plan(value, {}, nodes, seed=SEED))
        value = config()
        value["accounts"][0]["password"] = "\u4e00" * 10000
        normalized = routing.parse_config(json.dumps(value, ensure_ascii=False))
        plan = subscription_pool.make_plan(normalized, {}, [node(1)], seed=SEED)
        self.assertEqual(subscription_pool.resolve_random_accounts(normalized, plan, {}, [node(1)])[0]["proxies"],
                         [{"outbound": node(1)}])

    def test_default_compaction_preserves_profile_validation_and_custom_screen(self):
        value = config()
        for profile in ({"device_scale_factor": True}, {"viewport": {"width": 1440.0, "height": 900}},
                        {"viewport": {"width": 1440, "height": 900, "extra": "secret"}}):
            value["accounts"][0]["profile"] = profile
            self.assert_pool_fails(subscription_pool.make_plan, value, {}, [node(1)], seed=SEED)
        value["accounts"][0]["profile"] = {
            "viewport": {"width": 1000, "height": 800},
            "screen": {"width": 1440, "height": 900},
        }
        plan = subscription_pool.make_plan(value, {}, [node(1)], seed=SEED)
        result = subscription_pool.resolve_random_accounts(value, plan, {}, [node(1)])
        self.assertEqual(result[0]["profile"]["viewport"], {"width": 1000, "height": 800})
        self.assertEqual(result[0]["profile"]["screen"], {"width": 1440, "height": 900})

    def test_imports_and_plan_shape_validation_need_only_standard_library(self):
        command = ("import subscription_pool; import routing; "
                   "subscription_pool.validate_plan({'seed':'0'*32,'fingerprint':'1'*64}); "
                   "assert not subscription_pool.has_random([{'proxies':[{'link':'dummy'}]}])")
        result = subprocess.run([sys.executable, "-S", "-c", command], cwd=ROOT,
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
