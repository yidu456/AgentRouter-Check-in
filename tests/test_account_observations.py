import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import account_observations as observations


EMPTY = {"version": 1, "balances": {}}
ACCOUNT = {
    "id": "a01", "site": "https://example.com",
    "username": "private-user@example.com", "password": "private-password",
}


def account_key(account):
    identity = json.dumps(
        [account["id"], account["site"], account["username"]],
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(identity).hexdigest()


class HistoryTests(unittest.TestCase):
    def test_first_balance_has_unknown_baseline_and_keeps_extra_details(self):
        rows = [("a01", {"quota": 100, "exit_ip": "203.0.113.2", "balance": "0.00$"}, "SUCCESS")]
        accounts = {"a01": copy.deepcopy(ACCOUNT)}
        original = copy.deepcopy((rows, accounts, EMPTY))
        enriched, history = observations.apply_history(rows, accounts, EMPTY)
        self.assertEqual(enriched, [("a01", {
            "quota": 100, "exit_ip": "203.0.113.2", "balance": "0.00$", "previous_quota": None,
        }, "SUCCESS")])
        self.assertEqual(history, {"version": 1, "balances": {account_key(ACCOUNT): 100}})
        enriched[0][1]["balance"] = "changed"
        self.assertEqual((rows, accounts, EMPTY), original)

    def test_negative_and_zero_changes_use_previous_exact_quota(self):
        for quota in (80, 100, 0, 2**63 - 1):
            with self.subTest(quota=quota):
                old = {"version": 1, "balances": {account_key(ACCOUNT): 100, "f" * 64: 1}}
                original = copy.deepcopy(old)
                rows, new = observations.apply_history(
                    [("a01", {"quota": quota, "exit_ip": None}, "SUCCESS")], {"a01": ACCOUNT}, old,
                )
                self.assertEqual(rows[0][1]["previous_quota"], 100)
                self.assertEqual(new, {"version": 1, "balances": {account_key(ACCOUNT): quota}})
                self.assertEqual(old, original)

    def test_rebinding_any_identity_makes_baseline_unknown(self):
        old = {"version": 1, "balances": {account_key(ACCOUNT): 100}}
        for field in ("id", "site", "username"):
            account = dict(ACCOUNT, **{field: ACCOUNT[field] + "-changed"})
            with self.subTest(field=field):
                rows, new = observations.apply_history(
                    [("a01", {"quota": 1, "exit_ip": None}, "SUCCESS")], {"a01": account}, old,
                )
                self.assertIsNone(rows[0][1]["previous_quota"])
                self.assertEqual(new, {"version": 1, "balances": {account_key(account): 1}})

    def test_password_rotation_or_absence_keeps_same_identity_baseline(self):
        key = "f42de621633f76985bf1d9e8b61246155f0076f782ec5d372f0f645ebc27bfa7"
        old = {"version": 1, "balances": {key: 100}}
        identity_only = {field: ACCOUNT[field] for field in ("id", "site", "username")}
        accounts = [identity_only] + [dict(identity_only, password=value) for value in (
            "private-password", "rotated-password", None, 1,
        )]
        for account in accounts:
            with self.subTest(password=account.get("password")):
                rows, new = observations.apply_history(
                    [("a01", {"quota": 50, "exit_ip": None}, "SUCCESS")], {"a01": account}, old,
                )
                self.assertEqual(rows[0][1]["previous_quota"], 100)
                self.assertEqual(new, {"version": 1, "balances": {key: 50}})

    def test_history_key_does_not_read_password_or_derive_a_password_verifier(self):
        class IdentityOnly(dict):
            def get(self, key, default=None):
                if key == "password":
                    raise AssertionError("history must not read passwords")
                return super().get(key, default)

        _, history = observations.apply_history(
            [("a01", {"quota": 1, "exit_ip": None}, "SUCCESS")], {"a01": IdentityOnly(ACCOUNT)}, EMPTY,
        )
        self.assertEqual(history, {"version": 1, "balances": {
            "f42de621633f76985bf1d9e8b61246155f0076f782ec5d372f0f645ebc27bfa7": 1,
        }})

    def test_failed_row_preserves_baseline_without_fabricating_current_balance(self):
        old = {"version": 1, "balances": {account_key(ACCOUNT): 0}}
        for quota in (None, 50):
            with self.subTest(quota=quota):
                rows, new = observations.apply_history(
                    [("a01", {"quota": quota, "exit_ip": None}, "WAF_TIMEOUT")], {"a01": ACCOUNT}, old,
                )
                self.assertIsNone(rows[0][1]["quota"])
                self.assertEqual(rows[0][1]["previous_quota"], 0)
                self.assertEqual(new, old)

    def test_invalid_success_quota_never_replaces_history(self):
        old = {"version": 1, "balances": {account_key(ACCOUNT): 100}}
        for quota in (None, True, False, -1, 1.0, "1", 2**63):
            with self.subTest(quota=quota):
                rows, new = observations.apply_history(
                    [("a01", {"quota": quota, "exit_ip": None}, "SUCCESS")], {"a01": ACCOUNT}, old,
                )
                self.assertIsNone(rows[0][1]["quota"])
                self.assertEqual(rows[0][1]["previous_quota"], 100)
                self.assertEqual(new, old)

    def test_missing_binding_or_incomplete_identity_cannot_reuse_baseline(self):
        old = {"version": 1, "balances": {account_key(ACCOUNT): 100}}
        for accounts in ({}, {"a01": {}}, {"a01": dict(ACCOUNT, site=None)}, {"a01": dict(ACCOUNT, username="")}):
            with self.subTest(accounts=accounts):
                rows, new = observations.apply_history(
                    [("a01", {"quota": 5, "exit_ip": None}, "SUCCESS")], accounts, old,
                )
                self.assertIsNone(rows[0][1]["previous_quota"])
                self.assertEqual(new, EMPTY)

    def test_accounts_without_rows_keep_baseline_and_invalid_history_is_unknown(self):
        key = account_key(ACCOUNT)
        old = {"version": 1, "balances": {key: 100}}
        self.assertEqual(observations.apply_history([], {"a01": ACCOUNT}, old), ([], old))
        rows, new = observations.apply_history(
            [("a01", {"quota": 5, "exit_ip": None}, "SUCCESS")], {"a01": ACCOUNT}, {"version": 2},
        )
        self.assertIsNone(rows[0][1]["previous_quota"])
        self.assertEqual(new["balances"], {key: 5})

    def test_save_roundtrip_contains_only_opaque_key_and_quota(self):
        _, history = observations.apply_history(
            [("a01", {"quota": 0, "exit_ip": "203.0.113.2"}, "SUCCESS")], {"a01": ACCOUNT}, EMPTY,
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            self.assertTrue(observations.save_history(path, history))
            self.assertEqual(observations.load_history(path), history)
            content = path.read_text(encoding="utf-8")
            for secret in (*ACCOUNT.values(), "203.0.113.2", "username", "password", "proxy", "exit_ip"):
                self.assertNotIn(secret, content)
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_missing_malformed_duplicate_and_oversized_history_load_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            self.assertEqual(observations.load_history(path), EMPTY)
            payloads = [
                b"not json", b"\xff", b"[]", b'{"version":1,"version":1,"balances":{}}',
                b'{"version":1,"balances":{},"password":"secret"}',
                b'{"version":true,"balances":{}}',
                json.dumps({"version": 1, "balances": {"x" * 64: 1}}).encode(),
                json.dumps({"version": 1, "balances": {"A" * 64: 1}}).encode(),
                json.dumps({"version": 1, "balances": {"a" * 64: True}}).encode(),
                json.dumps({"version": 1, "balances": {"a" * 64: -1}}).encode(),
                json.dumps({"version": 1, "balances": {"a" * 64: 2**63}}).encode(),
                json.dumps({"version": 1, "balances": {f"{i:064x}": 1 for i in range(769)}}).encode(),
                b" " * (1024 * 1024 + 1),
            ]
            for payload in payloads:
                with self.subTest(size=len(payload)):
                    path.write_bytes(payload)
                    self.assertEqual(observations.load_history(path), EMPTY)

    def test_save_invalid_history_does_not_change_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            path.write_text("existing", encoding="utf-8")
            invalid = [
                {"version": 1, "balances": {"plaintext-id": 1}},
                {"version": 1, "balances": {"a" * 64: True}},
                {"version": 1, "balances": {"a" * 64: 2**63}},
                {"version": 1, "balances": {f"{i:064x}": 1 for i in range(769)}},
            ]
            for history in invalid:
                self.assertFalse(observations.save_history(path, history))
                self.assertEqual(path.read_text(encoding="utf-8"), "existing")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_atomic_write_failure_preserves_previous_file_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            old = {"version": 1, "balances": {"a" * 64: 1}}
            self.assertTrue(observations.save_history(path, old))
            with mock.patch.object(observations.os, "replace", side_effect=OSError("private-details")):
                self.assertFalse(observations.save_history(path, EMPTY))
            self.assertEqual(observations.load_history(path), old)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_atomic_replace_receives_complete_private_file_in_same_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            real_replace = os.replace

            def replace(source, destination):
                self.assertEqual(Path(source).parent, path.parent)
                self.assertEqual(Path(destination), path)
                self.assertEqual(json.loads(Path(source).read_text(encoding="utf-8")), EMPTY)
                if os.name != "nt":
                    self.assertEqual(Path(source).stat().st_mode & 0o777, 0o600)
                real_replace(source, destination)

            with mock.patch.object(observations.os, "replace", side_effect=replace):
                self.assertTrue(observations.save_history(path, EMPTY))


class ExitIPTests(unittest.TestCase):
    def query(self, proxy, chunks=(b"203.0.113.2\n",), status=200, error=None):
        response = mock.Mock(status_code=status, headers={})
        response.iter_content.return_value = iter(chunks)
        session = mock.Mock(trust_env=True)
        session.get.return_value = response
        if error:
            session.get.side_effect = error
        with mock.patch.dict(sys.modules, {"requests": SimpleNamespace(Session=lambda: session)}):
            result = observations.query_exit_ip(proxy)
        return result, session, response

    def test_query_uses_only_selected_proxy_without_redirect_or_environment_fallback(self):
        proxy = {"server": "http://127.0.0.1:18080"}
        original = copy.deepcopy(proxy)
        with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://bad:1", "HTTPS_PROXY": "http://bad:2"}):
            result, session, response = self.query(proxy)
        self.assertEqual(result, "203.0.113.2")
        self.assertFalse(session.trust_env)
        session.get.assert_called_once_with(
            "https://api.ipify.org",
            proxies={"http": proxy["server"], "https": proxy["server"]},
            timeout=5, allow_redirects=False, stream=True,
        )
        session.close.assert_called_once()
        response.close.assert_called_once()
        self.assertEqual(proxy, original)

    def test_query_canonicalizes_plain_ipv6_and_encodes_proxy_auth(self):
        proxy = {"server": "socks5h://[::1]:18080", "username": "user:@", "password": "pa:ss/#"}
        result, session, _ = self.query(proxy, chunks=(b"2001:0DB8:0000:0000:0000:0000:0000:0001",))
        self.assertEqual(result, "2001:db8::1")
        encoded_auth = "user%3A%40" + ":" + "%".join(("pa", "3Ass", "2F", "23"))
        self.assertEqual(session.get.call_args.kwargs["proxies"], {
            "http": "socks5h://" + encoded_auth + "@[::1]:18080",
            "https": "socks5h://" + encoded_auth + "@[::1]:18080",
        })

    def test_absent_or_malformed_proxy_never_opens_session(self):
        invalid = [
            None, {}, "http://127.0.0.1:18080", {"server": ""},
            {"server": "127.0.0.1:18080"}, {"server": "file:///tmp/proxy"},
            {"server": "http://"}, {"server": "http://localhost:0"},
            {"server": "http://localhost:65536"}, {"server": "http://localhost:bad"},
            {"server": "http://localhost:80/path"}, {"server": "http://localhost:80?secret"},
            {"server": "http://localhost:80", "username": "user"},
            {"server": "http://localhost:80", "username": True, "password": "pass"},
            {"server": "http://localhost:80", "username": "", "password": "pass"},
            {"server": "socks4://localhost:80", "username": "user", "password": "pass"},
            {"server": "socks4a://localhost:80", "username": "user", "password": "pass"},
            {"server": "socks4://" + "user:pass" + "@localhost:80"},
            {"server": "http://" + "user:pass" + "@localhost:80", "username": "other", "password": "pass"},
            {"server": "http://local\nhost:80"},
        ]
        session_factory = mock.Mock(side_effect=AssertionError("unexpected network session"))
        with mock.patch.dict(sys.modules, {"requests": SimpleNamespace(Session=session_factory)}):
            for proxy in invalid:
                with self.subTest(proxy=proxy):
                    self.assertIsNone(observations.query_exit_ip(proxy))
        session_factory.assert_not_called()

    def test_non_ip_redirect_and_oversized_responses_are_unknown(self):
        bodies = (
            b"", b"not-an-ip", b'{"ip":"203.0.113.2"}', b"http://203.0.113.2",
            b"203.0.113.2 private-details", b"fe80::1%eth0", b"\xff", b"x" * 129,
        )
        for body in bodies:
            with self.subTest(body=body[:40]):
                result, session, response = self.query({"server": "http://127.0.0.1:18080"}, chunks=(body,))
                self.assertIsNone(result)
                session.close.assert_called_once()
                response.close.assert_called_once()
        for status in (301, 302, 307, 400, 500):
            result, _, response = self.query({"server": "http://127.0.0.1:18080"}, status=status)
            self.assertIsNone(result)
            response.iter_content.assert_not_called()

    def test_body_limit_stops_stream_consumption_and_closes_resources(self):
        def chunks():
            yield b" " * 128
            yield b"203.0.113.2"
            raise AssertionError("must stop reading after oversized body")

        result, session, response = self.query({"server": "http://127.0.0.1:18080"}, chunks=chunks())
        self.assertIsNone(result)
        response.iter_content.assert_called_once_with(chunk_size=128)
        session.close.assert_called_once()
        response.close.assert_called_once()

    def test_network_failure_is_unknown_and_never_retries_or_logs_private_details(self):
        with mock.patch("builtins.print") as output:
            result, session, _ = self.query(
                {"server": "http://127.0.0.1:18080"}, error=OSError("credential-error"),
            )
        self.assertIsNone(result)
        session.get.assert_called_once()
        session.close.assert_called_once()
        output.assert_not_called()

    def test_module_import_and_history_do_not_require_requests(self):
        code = (
            "import builtins; original=builtins.__import__; "
            "builtins.__import__=lambda name,*a,**k: "
            "(_ for _ in ()).throw(ImportError('blocked')) if name=='requests' else original(name,*a,**k); "
            "import account_observations as o; "
            "assert o.load_history('nonexistent-history.json')=={'version':1,'balances':{}}; "
            "assert o.query_exit_ip({'server':'http://127.0.0.1:18080'}) is None"
        )
        completed = subprocess.run(
            [sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "")


if __name__ == "__main__":
    unittest.main()
