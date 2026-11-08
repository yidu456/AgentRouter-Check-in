import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import account_observations as observations
import app
import report
import routing


IP = "8.8.8.8"
PROXY = {"server": "http://127.0.0.1:18080"}
LOCATION = {"name": "United States", "code": "US", "timezone_id": "America/Los_Angeles"}


class ProxyTimezoneLookupTests(unittest.TestCase):
    def query(self, payload, status=200, chunks=None, proxy=PROXY):
        response = Mock(status_code=status)
        response.iter_content.return_value = chunks or [json.dumps(payload).encode()]
        session = Mock()
        session.get.return_value = response
        with patch("requests.Session", return_value=session):
            result = observations.query_country(IP, proxy=proxy, include_timezone=True)
        self.assertFalse(session.trust_env)
        session.get.assert_called_once_with(
            f"https://ipwho.is/{IP}",
            params={"fields": "success,ip,country,country_code,timezone.id", "lang": "zh-CN"},
            proxies={"http": PROXY["server"], "https": PROXY["server"]},
            timeout=5, allow_redirects=False, stream=True,
        )
        response.close.assert_called_once()
        session.close.assert_called_once()
        return result

    def payload(self, zone="America/Los_Angeles"):
        return {"success": True, "ip": IP, "country": "United States", "country_code": "US",
                "timezone": {"id": zone}, "private": "must-not-propagate"}

    def test_lookup_uses_same_proxy_and_specific_iana_timezone(self):
        self.assertEqual(self.query(self.payload()), LOCATION)
        for zone in ("Asia/Singapore", "Asia/Seoul", "Asia/Tokyo", "Europe/Berlin",
                     "America/New_York", "Asia/Hong_Kong", "Etc/UTC"):
            with self.subTest(zone=zone):
                self.assertEqual(self.query(self.payload(zone))["timezone_id"], zone)

    def test_missing_invalid_or_unrecognized_timezone_fails_closed(self):
        for zone in (None, True, "", "UTC+8", "Invalid/Timezone", "../Asia/Tokyo",
                     "/Asia/Tokyo", "Asia/Tokyo\nprivate", "x" * 129):
            with self.subTest(zone=zone):
                self.assertIsNone(self.query(self.payload(zone)))
        for timezone in (None, "Asia/Tokyo", {}, []):
            payload = self.payload()
            payload["timezone"] = timezone
            self.assertIsNone(self.query(payload))

    def test_bad_proxy_never_falls_back_to_direct(self):
        for proxy in (None, {}, {"server": "private"}, {"server": "http://host/?secret=yes"}):
            with self.subTest(proxy=proxy), patch("requests.Session") as session:
                self.assertIsNone(observations.query_country(IP, proxy=proxy, include_timezone=True))
                session.assert_not_called()

    def test_failed_lookup_does_not_retry_or_forward_on_redirect(self):
        self.assertIsNone(self.query(self.payload(), status=302))
        self.assertIsNone(self.query(self.payload(), status=429))
        self.assertIsNone(self.query(self.payload(), chunks=[b"x" * 4097]))
        payload = self.payload()
        payload["ip"] = "1.1.1.1"
        self.assertIsNone(self.query(payload))
        session = Mock()
        session.get.side_effect = RuntimeError("private")
        with patch("requests.Session", return_value=session):
            self.assertIsNone(observations.query_country(IP, proxy=PROXY, include_timezone=True))
        self.assertEqual(session.get.call_count, 1)
        session.close.assert_called_once()


class AutomaticTimezoneTests(unittest.TestCase):
    def test_each_candidate_is_observed_before_login_and_profile_is_not_mutated(self):
        candidates = [PROXY, {"server": "http://127.0.0.1:18081"}]
        profile = {"locale": "en-US", "timezone_id": "Asia/Shanghai"}
        original = copy.deepcopy(profile)
        events = []
        zones = iter((LOCATION, dict(LOCATION, timezone_id="America/New_York")))

        def exit_ip(proxy):
            events.append(("ip", proxy["server"]))
            return IP

        def location(ip, **kwargs):
            events.append(("location", kwargs["proxy"]["server"]))
            self.assertTrue(kwargs["include_timezone"])
            return next(zones)

        def login(account, **kwargs):
            events.append(("login", kwargs["profile"]["timezone_id"]))
            return (None, "WAF_TIMEOUT") if len(events) == 3 else ({"quota": 1}, "SUCCESS")

        detail = {}
        with patch.object(observations, "query_exit_ip", side_effect=exit_ip), \
                patch.object(observations, "query_country", side_effect=location), \
                patch.object(app, "browser_login_complete", side_effect=login):
            result = app.checkin_assigned_account({"id": "a01"}, candidates, profile, detail)
        self.assertEqual(result, ({"quota": 1}, "SUCCESS"))
        self.assertEqual(events, [("ip", PROXY["server"]), ("location", PROXY["server"]),
                                  ("login", "America/Los_Angeles"), ("ip", candidates[1]["server"]),
                                  ("location", candidates[1]["server"]), ("login", "America/New_York")])
        self.assertEqual(profile, original)
        self.assertEqual(detail, {"exit_ip": IP, "country": {"name": "United States", "code": "US"},
                                  "timezone_id": "America/New_York"})

    def test_observation_failure_skips_node_without_sending_credentials(self):
        for ip, location, expected in ((None, LOCATION, "EXIT_IP_FAIL"), (IP, None, "TIMEZONE_LOOKUP_FAIL")):
            with self.subTest(ip=ip), patch.object(observations, "query_exit_ip", return_value=ip), \
                    patch.object(observations, "query_country", return_value=location) as country, \
                    patch.object(app, "browser_login_complete") as login, patch.object(app, "log") as log:
                result = app.checkin_assigned_account({"id": "a01"}, [PROXY], {})
                self.assertEqual(result, (None, expected))
                login.assert_not_called()
                if ip is None:
                    country.assert_not_called()
                self.assertEqual(log.call_args.args[0], f"a01 attempt1: {expected}")

    def test_failed_lookup_then_next_candidate_can_log_in(self):
        with patch.object(observations, "query_exit_ip", return_value=IP), \
                patch.object(observations, "query_country", side_effect=[None, LOCATION]), \
                patch.object(app, "browser_login_complete", return_value=({"quota": 2}, "SUCCESS")) as login:
            result = app.checkin_assigned_account({}, [PROXY, {"server": "http://127.0.0.1:18081"}], {})
        self.assertEqual(result, ({"quota": 2}, "SUCCESS"))
        login.assert_called_once()
        self.assertEqual(login.call_args.kwargs["proxy"]["server"], "http://127.0.0.1:18081")

    def test_failed_candidate_clears_previous_location_and_keeps_errors_private(self):
        detail = {}
        with patch.object(observations, "query_exit_ip", side_effect=[IP, None]), \
                patch.object(observations, "query_country", return_value=LOCATION), \
                patch.object(app, "browser_login_complete", return_value=(None, "WAF_TIMEOUT")):
            result = app.checkin_assigned_account({}, [PROXY, PROXY], {}, detail)
        self.assertEqual(result, (None, "EXIT_IP_FAIL"))
        self.assertEqual(detail, {"exit_ip": None, "country": None, "timezone_id": None})
        with patch.object(observations, "query_exit_ip", side_effect=RuntimeError("private-secret")), \
                patch.object(app, "browser_login_complete") as login, patch.object(app, "log") as log:
            self.assertEqual(app.checkin_assigned_account({}, [PROXY], {}), (None, "EXIT_IP_FAIL"))
        login.assert_not_called()
        self.assertNotIn("private-secret", str(log.call_args))

    def test_reports_preserve_observed_location_without_new_direct_lookup(self):
        group = {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["a01"], "mode": "isolated"}
        row = {"id": "a01", "quota": 1, "stage": "SUCCESS", "exit_ip": IP,
               "country": {"name": "United States", "code": "US"}, "timezone_id": "America/Los_Angeles"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "checkin-results-g01" / "result.json"
            path.parent.mkdir()
            report.write_report(path, group, [row])
            rows = report.combine_reports({"version": 1, "groups": [group]}, root, details=True)
        with patch.object(observations, "query_country") as query:
            enriched = observations.enrich_countries(rows)
        query.assert_not_called()
        self.assertEqual(enriched[0][1]["country"], row["country"])
        self.assertEqual(enriched[0][1]["timezone_id"], row["timezone_id"])

    def test_report_rejects_forged_location_fields_and_accepts_safe_failure(self):
        group = {"group_id": "g01", "os": "ubuntu-24.04", "account_ids": ["a01"], "mode": "isolated"}
        row = {"id": "a01", "quota": None, "stage": "TIMEZONE_LOOKUP_FAIL", "country": None,
               "timezone_id": None, "exit_ip": IP}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            report.write_report(path, group, [row])
            for fields in ({"country": {"name": "US\nsecret", "code": "US"}},
                           {"country": {"name": "US", "code": "US", "extra": "secret"}},
                           {"timezone_id": "Invalid/Timezone"}, {"timezone_id": True}):
                with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, "^REPORT_INVALID$"):
                    report.write_report(path, group, [dict(row, **fields)])
        with patch.object(observations, "query_country") as query:
            rows = observations.enrich_countries([("a01", row, row["stage"])])
        self.assertIsNone(rows[0][1]["country"])
        query.assert_not_called()

    def test_supplied_six_region_profiles_are_compatible_but_not_required(self):
        for zone in ("Asia/Singapore", "Asia/Seoul", "Europe/Berlin", "Asia/Hong_Kong"):
            with self.subTest(zone=zone):
                self.assertEqual(routing._profile({"timezone_id": zone})["timezone_id"], zone)
        self.assertIsInstance(routing._profile({}), dict)


if __name__ == "__main__":
    unittest.main()
