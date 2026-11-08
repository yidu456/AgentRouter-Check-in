import contextlib
import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests
import routing
import subscription_pool


SECRET = "private-credential-marker"


def configuration():
    return {"version": 2, "subscription_url": f"https://subscription.example.com/{SECRET}",
            "groups": {"ubuntu": {"accounts": [{
                "id": "private_account", "username": "private-user@example.com", routing.PASSWORD_KEY: SECRET,
                "proxies": [{"link": f"socks5://fixed.example.com:1080#{SECRET}"}, {"random": 2}],
                "profile": {"locale": "en-US"},
            }]}}}


def response(links):
    result = Mock(status_code=200)
    result.iter_content.return_value = [links.encode()]
    return result


class PrepareDiagnosticsTests(unittest.TestCase):
    def run_prepare(self, config=None, http=None, failure=None, bad_path=False):
        value = configuration() if config is None else config
        raw = value if isinstance(value, str) else json.dumps(value)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ("missing/manifest.json" if bad_path else "manifest.json")
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.dict(os.environ, {"CHECKIN_CONFIG": raw}, clear=True), \
                    patch("requests.get", return_value=http or response("socks5://one.example.com:1080\n"
                                                                          "socks5://two.example.com:1080"),
                          side_effect=failure) as get, \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = routing.main(["prepare", "--manifest", str(target)])
            output = stdout.getvalue() + stderr.getvalue()
            for marker in (SECRET, "private_account", "private-user@example.com", "subscription.example.com",
                           "fixed.example.com", "one.example.com", "two.example.com"):
                self.assertNotIn(marker, output)
            return code, output, target.exists(), get.call_count

    def test_empty_password_identifies_field_without_echoing_account(self):
        value = configuration()
        value["groups"]["ubuntu"]["accounts"][0][routing.PASSWORD_KEY] = ""
        code, output, written, calls = self.run_prepare(value)
        self.assertEqual((code, written, calls), (1, False, 0))
        self.assertIn(f"field=groups.ubuntu.accounts[0].{routing.PASSWORD_KEY}", output)
        self.assertIn("reason=NONEMPTY_STRING", output)

    def test_profile_and_proxy_errors_have_specific_locations(self):
        cases = [("profile", {"locale": "private-locale"}, "profile.locale", "INVALID_CHOICE"),
                 ("profile", {"viewport": {"width": 1, "height": 720}}, "profile.viewport.width", "INTEGER_RANGE"),
                 ("proxies", [{"random": True}], "proxies[0].random", "INTEGER_RANGE"),
                 ("proxies", [{"link": "secret-invalid-link"}], "proxies[0].link", "URL_INVALID")]
        for field, replacement, location, reason in cases:
            value = configuration()
            value["groups"]["ubuntu"]["accounts"][0][field] = replacement
            with self.subTest(field=field):
                code, output, written, calls = self.run_prepare(value)
                self.assertEqual((code, written, calls), (1, False, 0))
                self.assertIn("field=groups.ubuntu.accounts[0]." + location, output)
                self.assertIn("reason=" + reason, output)
                self.assertNotIn("private-locale", output)
                self.assertNotIn("secret-invalid-link", output)

    def test_duplicate_identity_and_unknown_field_are_safe(self):
        value = configuration()
        first = value["groups"]["ubuntu"]["accounts"][0]
        second = copy.deepcopy(first)
        second["id"] = "second_account"
        second["proxies"] = [{"random": 2}]
        value["groups"]["ubuntu"]["accounts"].append(second)
        code, output, _, _ = self.run_prepare(value)
        self.assertEqual(code, 1)
        self.assertIn("reason=DUPLICATE_LOGIN", output)
        self.assertIn("field=groups.ubuntu.accounts[1].username", output)
        value = configuration()
        value[SECRET] = SECRET
        code, output, _, _ = self.run_prepare(value)
        self.assertEqual(code, 1)
        self.assertIn("field=config reason=FIELDS_INVALID", output)

    def test_bad_json_has_coordinates_and_duplicate_keys_do_not_echo_names(self):
        code, output, _, calls = self.run_prepare('{\n"' + SECRET + '":')
        self.assertEqual((code, calls), (1, 0))
        self.assertIn("reason=JSON_INVALID", output)
        self.assertIn("line=2", output)
        self.assertIn("column=", output)
        code, output, _, _ = self.run_prepare('{"' + SECRET + '":1,"' + SECRET + '":2}')
        self.assertEqual(code, 1)
        self.assertIn("reason=JSON_DUPLICATE_KEY", output)

    def test_v1_and_notification_field_locations_keep_exception_code_compatible(self):
        source = configuration()["groups"]["ubuntu"]["accounts"][0]
        value = {"version": 1, "accounts": [dict(source, os="ubuntu", proxies=[{"link": "socks5://host:1080"}])],
                 "notifications": {"wecom": {"webhook_url": SECRET}}}
        code, output, _, calls = self.run_prepare(value)
        self.assertEqual((code, calls), (1, 0))
        self.assertIn("field=notifications.wecom.webhook_url reason=URL_INVALID", output)
        value.pop("notifications")
        value["accounts"][0]["profile"] = {"device_scale_factor": 1.25}
        code, output, _, calls = self.run_prepare(value)
        self.assertEqual((code, calls), (1, 0))
        self.assertIn("field=accounts[0].profile.device_scale_factor", output)
        with self.assertRaisesRegex(ValueError, "^ROUTE_CONFIG_FAIL$"):
            routing.parse_config(json.dumps(value))

    def test_http_and_request_errors_do_not_emit_response_or_url(self):
        http = response(SECRET)
        http.status_code = 403
        http.raise_for_status.side_effect = requests.HTTPError(f"https://example.com/{SECRET}")
        code, output, written, calls = self.run_prepare(http=http)
        self.assertEqual((code, written, calls), (1, False, 1))
        self.assertIn("reason=SUBSCRIPTION_HTTP_ERROR", output)
        self.assertIn("status=403", output)
        self.assertIn("PREPARE_CONFIG_OK", output)
        code, output, _, _ = self.run_prepare(failure=requests.Timeout(SECRET))
        self.assertEqual(code, 1)
        self.assertIn("reason=SUBSCRIPTION_TIMEOUT", output)

    def test_json_subscription_and_all_rejected_nodes_have_distinct_reasons(self):
        code, output, _, _ = self.run_prepare(http=response('{"outbounds":[],"private":"' + SECRET + '"}'))
        self.assertEqual(code, 1)
        self.assertIn("reason=SUBSCRIPTION_FORMAT_INVALID", output)
        code, output, _, _ = self.run_prepare(http=response("unsupported://" + SECRET))
        self.assertEqual(code, 1)
        self.assertIn("reason=SUBSCRIPTION_NO_VALID_NODES", output)
        self.assertIn("total=1", output)
        self.assertIn("rejected=1", output)

    def test_named_duplicate_and_read_failure_do_not_emit_sensitive_data(self):
        value = configuration()
        value["groups"]["ubuntu"]["accounts"][0]["proxies"] = [{"node": SECRET}, {"random": 1}]
        http = response(f"socks5://one.example.com:1080#{SECRET}\nsocks5://two.example.com:1080#{SECRET}")
        code, output, _, _ = self.run_prepare(value, http=http)
        self.assertEqual(code, 1)
        self.assertIn("reason=SUBSCRIPTION_DUPLICATE_NODE_NAME", output)
        http = response("")
        http.iter_content.side_effect = requests.Timeout(SECRET)
        code, output, _, _ = self.run_prepare(http=http)
        self.assertEqual(code, 1)
        self.assertIn("reason=SUBSCRIPTION_TIMEOUT", output)

    def test_counts_cover_filtering_deduplication_fixed_exclusion_and_capacity(self):
        http = response("socks5://fixed.example.com:1080\n"
                        "socks5://one.example.com:1080#first\n"
                        "socks5://one.example.com:1080#renamed\nunsupported://private-credential-marker")
        code, output, written, calls = self.run_prepare(http=http)
        self.assertEqual((code, written, calls), (1, False, 1))
        for expected in ("reason=POOL_STATS", "total=4", "valid=3", "rejected=1", "duplicate=1",
                         "distinct=2", "reason=POOL_TOO_SMALL", "excluded=1", "available=1", "requested=2"):
            self.assertIn(expected, output)

    def test_success_stats_do_not_change_manifest_or_fingerprint(self):
        code, output, written, calls = self.run_prepare()
        self.assertEqual((code, written, calls), (0, True, 1))
        self.assertIn("reason=POOL_CAPACITY_STATS", output)
        self.assertIn("available=2", output)
        self.assertIn("requested=2", output)
        self.assertIn("MANIFEST_READY", output)
        from proxy_runtime import parse_node_link
        value = routing.parse_config(json.dumps(configuration()))
        nodes = [parse_node_link(f"socks5://{host}.example.com:1080", "node") for host in ("one", "two")]
        normal = subscription_pool.make_plan(value, {}, nodes, seed="a" * 32)
        with contextlib.redirect_stdout(io.StringIO()):
            diagnostic = subscription_pool.make_plan(value, {}, nodes, seed="a" * 32, diagnostics=True)
        self.assertEqual(normal, diagnostic)
        self.assertEqual(set(normal), {"seed", "fingerprint"})

    def test_fixed_link_conversion_failure_has_no_node_values(self):
        value = configuration()
        value["groups"]["ubuntu"]["accounts"][0]["proxies"][0] = {
            "link": f"vless://{SECRET}@fixed.example.com:443?encryption=none"}
        code, output, written, _ = self.run_prepare(value)
        self.assertEqual((code, written), (1, False))
        self.assertIn("reason=FIXED_LINK_INVALID", output)
        self.assertIn("account_index=0", output)
        self.assertIn("proxy_index=0", output)

    def test_failed_manifest_write_is_not_misreported_as_bad_config(self):
        code, output, written, _ = self.run_prepare(bad_path=True)
        self.assertEqual((code, written), (1, False))
        self.assertIn("field=manifest reason=MANIFEST_WRITE_FAIL", output)

    def test_renderer_rejects_forged_fields_reasons_and_noninteger_counts(self):
        value = {"field": SECRET, "reason": SECRET, "status": SECRET, "available": True, "extra": SECRET}
        output = routing.format_diagnostic(value)
        self.assertNotIn(SECRET, output)
        self.assertNotIn("available=", output)
        self.assertNotIn("status=", output)
        self.assertIn("field=config reason=INVALID", output)
        self.assertNotIn(SECRET, routing.format_diagnostic({"field": "profile." + SECRET, "reason": "INVALID"}))


if __name__ == "__main__":
    unittest.main()
