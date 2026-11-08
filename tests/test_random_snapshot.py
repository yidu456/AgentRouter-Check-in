import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nacl.secret import SecretBox

import random_snapshot
import routing
import subscription_pool


PRIVATE = "private-snapshot-marker"
CONTEXT = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "owner/example",
           "GITHUB_RUN_ID": "123", "GITHUB_SHA": "a" * 40}


def configuration():
    return {"version": 1, "subscription_url": "https://subscription.example.test/sub", "accounts": [
        {"id": "a01", "os": "ubuntu", "username": "one@example.test", "password": PRIVATE,
         "proxies": [{"link": "socks5://fixed.example.test:1080"}, {"random": 1}]},
        {"id": "a02", "os": "macos", "username": "two@example.test", "password": PRIVATE,
         "proxies": [{"node": "named"}, {"random": 1}]},
    ]}


def pool():
    return [{"type": "socks", "server": f"pool{index}.example.test", "server_port": 1080, "version": "5"}
            for index in range(4)]


class RandomSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.config = routing.parse_config(json.dumps(configuration()))
        self.nodes = pool()
        self.names = {"named": "socks5://pool0.example.test:1080#named"}
        self.plan = subscription_pool.make_plan(self.config, self.names, self.nodes, seed="a" * 32)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "random-pool.bin"
        env = patch.dict(os.environ, CONTEXT, clear=True)
        env.start()
        self.addCleanup(env.stop)
        for target in ("requests.get", "socket.create_connection", "proxy_runtime.subprocess.Popen"):
            guard = patch(target, side_effect=AssertionError("external operation blocked"))
            guard.start()
            self.addCleanup(guard.stop)

    def write(self):
        random_snapshot.write_snapshot(self.path, self.config, self.plan, self.names, self.nodes)

    def assert_failure(self, reason, action, *args):
        with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$") as caught:
            action(*args)
        self.assertEqual(caught.exception.diagnostic, {"field": "random_plan", "reason": reason})
        self.assertNotIn(PRIVATE, str(caught.exception))

    def test_round_trip_preserves_global_plan_fixed_order_and_private_inputs(self):
        original = copy.deepcopy((self.config, self.names, self.nodes, self.plan))
        self.write()
        expected = subscription_pool.resolve_random_accounts(self.config, self.plan, self.names, self.nodes)
        self.assertEqual(random_snapshot.load_snapshot(self.path, self.config, self.plan), expected)
        self.assertEqual((self.config, self.names, self.nodes, self.plan), original)
        self.assertEqual(expected[0]["proxies"][0], {"link": "socks5://fixed.example.test:1080"})
        self.assertEqual(len({account["proxies"][1]["outbound"]["server"] for account in expected}), 2)
        data = self.path.read_bytes()
        for value in (PRIVATE, "example.test", "named", self.plan["seed"], self.plan["fingerprint"]):
            self.assertNotIn(value.encode(), data)
        if os.name != "nt":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_random_nonce_and_reordered_normalized_configuration_are_supported(self):
        self.write()
        other = self.path.with_name("other.bin")
        random_snapshot.write_snapshot(other, self.config, self.plan, self.names, self.nodes)
        self.assertNotEqual(other.read_bytes(), self.path.read_bytes())
        reordered = copy.deepcopy(self.config)
        reordered["accounts"].reverse()
        routes = random_snapshot.load_snapshot(self.path, reordered, self.plan)
        self.assertEqual({row["id"] for row in routes}, {"a01", "a02"})
        self.assertEqual(len(routes), 2)

    def test_changed_config_and_cross_run_replay_fail_closed(self):
        self.write()
        changed = copy.deepcopy(self.config)
        changed["accounts"][0]["profile"]["locale"] = "en-US"
        self.assert_failure("SNAPSHOT_INVALID", random_snapshot.load_snapshot, self.path, changed, self.plan)
        for key, value in (("GITHUB_RUN_ID", "124"), ("GITHUB_REPOSITORY", "other/example"),
                           ("GITHUB_SHA", "b" * 40)):
            with self.subTest(context=key), patch.dict(os.environ, {key: value}):
                self.assert_failure("SNAPSHOT_INVALID", random_snapshot.load_snapshot,
                                    self.path, self.config, self.plan)
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}):
            self.assertEqual(len(random_snapshot.load_snapshot(self.path, self.config, self.plan)), 2)

    def test_missing_actions_context_and_missing_file_are_safe(self):
        for key in ("GITHUB_RUN_ID", "GITHUB_REPOSITORY", "GITHUB_SHA"):
            with self.subTest(key=key), patch.dict(os.environ, {key: ""}):
                self.assert_failure("SNAPSHOT_CONTEXT_INVALID", random_snapshot.write_snapshot,
                                    self.path, self.config, self.plan, self.names, self.nodes)
                self.assertFalse(self.path.exists())
        self.assert_failure("SNAPSHOT_MISSING", random_snapshot.load_snapshot,
                            self.path, self.config, self.plan)

    def test_corrupted_truncated_and_oversized_ciphertext_are_rejected(self):
        self.write()
        original = self.path.read_bytes()
        for data in (b"", original[:10], original[:-1], original[:-1] + bytes([original[-1] ^ 1])):
            self.path.write_bytes(data)
            with self.subTest(size=len(data)):
                self.assert_failure("SNAPSHOT_INVALID", random_snapshot.load_snapshot,
                                    self.path, self.config, self.plan)
        self.path.write_bytes(original)
        with patch.object(random_snapshot, "MAX_SNAPSHOT_BYTES", 10):
            self.assert_failure("SNAPSHOT_TOO_LARGE", random_snapshot.load_snapshot,
                                self.path, self.config, self.plan)

    def test_authenticated_bad_payload_schema_plan_and_nodes_are_rejected(self):
        payload = {"version": 1, "plan": self.plan, "named_links": self.names, "nodes": self.nodes}
        cases = [dict(payload, version=True), dict(payload, extra=PRIVATE), dict(payload, nodes=None),
                 dict(payload, plan=dict(self.plan, seed="b" * 32)),
                 dict(payload, nodes=[dict(self.nodes[0], server_port=True)]),
                 dict(payload, named_links={"named": "socks5://missing.example.test:1080"})]
        for item in cases:
            data = SecretBox(random_snapshot._key(self.config)).encrypt(json.dumps(item).encode())
            self.path.write_bytes(data)
            with self.subTest(keys=set(item)), self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
                random_snapshot.load_snapshot(self.path, self.config, self.plan)
        duplicate = json.dumps(payload)[:-1] + ',"version":1}'
        self.path.write_bytes(SecretBox(random_snapshot._key(self.config)).encrypt(duplicate.encode()))
        self.assert_failure("SNAPSHOT_INVALID", random_snapshot.load_snapshot,
                            self.path, self.config, self.plan)

    def test_oversized_write_existing_file_and_invalid_plan_do_not_overwrite(self):
        with patch.object(random_snapshot, "MAX_SNAPSHOT_BYTES", 10):
            self.assert_failure("SNAPSHOT_TOO_LARGE", random_snapshot.write_snapshot,
                                self.path, self.config, self.plan, self.names, self.nodes)
        self.assertFalse(self.path.exists())
        self.path.write_bytes(b"existing-data")
        self.assert_failure("SNAPSHOT_WRITE_FAIL", random_snapshot.write_snapshot,
                            self.path, self.config, self.plan, self.names, self.nodes)
        self.assertEqual(self.path.read_bytes(), b"existing-data")
        with self.assertRaisesRegex(ValueError, "^RANDOM_POOL_FAIL$"):
            random_snapshot.write_snapshot(self.path, self.config, {}, self.names, self.nodes)
        self.assertEqual(self.path.read_bytes(), b"existing-data")


if __name__ == "__main__":
    unittest.main()
