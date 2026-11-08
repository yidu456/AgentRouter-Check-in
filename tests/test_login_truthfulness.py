import unittest
from unittest.mock import MagicMock, patch

import app


ACCOUNT = {"site": "https://example.test", "username": "dummy-user", "password": "dummy-secret"}


def self_result(user_id=17, quota=500000):
    return {"success": True, "status": 200, "user_id": 17,
            "payload": {"success": True, "data": {"id": user_id, "username": "dummy-user", "quota": quota, "group": "default"}}}


class LoginTruthfulnessTests(unittest.TestCase):
    def run_browser(self, api_results, login_payload=None, response_url=None, account=None):
        account = ACCOUNT if account is None else account
        page = MagicMock()
        callbacks = {}
        page.on.side_effect = lambda name, callback: callbacks.setdefault(name, callback)
        response = MagicMock(status=200, url=response_url or ACCOUNT["site"] + "/api/user/login")
        response.request.method = "POST"
        response.json.return_value = login_payload
        submit = MagicMock()
        submit.click.side_effect = lambda **kwargs: (
            callbacks["response"](response) if login_payload is not None and "response" in callbacks else None
        )
        responses = iter(api_results)

        def evaluate(script, *args):
            if "/api/user/self" in script:
                return next(responses)
            if "maxAttempts = 30" in script:
                return {"success": True}
            return False

        page.evaluate.side_effect = evaluate
        with patch.object(app, "sync_playwright") as factory, \
                patch.object(app, "wait_for_waf_ready", return_value=True), \
                patch.object(app, "_first_visible_locator", side_effect=[MagicMock(), MagicMock(), submit]):
            browser = factory.return_value.__enter__.return_value.chromium.launch.return_value
            browser.new_context.return_value.new_page.return_value = page
            result = app.browser_login_complete(account, proxy={"server": "http://127.0.0.1:18080"}, isolated=True)
        return result, page

    def test_quota_cannot_promote_a_failed_login_stage_to_success(self):
        self.assertEqual(app._safe_login_result({"quota": 500000}, "USER_API_FAIL"), (None, "USER_API_FAIL"))

    def test_claimed_success_without_authentication_or_balance_is_rejected(self):
        self.assertEqual(app._safe_login_result({"quota": None}, "SUCCESS"), (None, "UNEXPECTED"))

    def test_proven_login_without_balance_stays_successful(self):
        self.assertEqual(app._safe_login_result({"quota": None, "authenticated": True}, "SUCCESS"), (None, "SUCCESS"))

    def test_authenticated_self_identity_must_match_requested_identity(self):
        result, _ = self.run_browser([self_result(user_id=18)])
        self.assertEqual(result, (None, "AUTH_IDENTITY_MISMATCH"))

    def test_quota_without_authoritative_self_identity_is_not_login_success(self):
        payload = self_result()
        payload["payload"]["data"].pop("id")
        result, _ = self.run_browser([payload])
        self.assertEqual(result, (None, "LOGIN_UNVERIFIED"))

    def test_valid_self_preserves_old_keyless_login(self):
        result, _ = self.run_browser([self_result()])
        self.assertEqual(result, ({"quota": 500000, "user_group": "default"}, "SUCCESS"))

    def test_self_identity_must_match_configured_username_without_login_response(self):
        payload = self_result()
        payload["payload"]["data"]["username"] = "another-user"
        result, _ = self.run_browser([payload])
        self.assertEqual(result, (None, "AUTH_IDENTITY_MISMATCH"))

    def test_no_login_response_or_account_name_leaves_login_unverified(self):
        payload = self_result()
        payload["payload"]["data"].pop("username")
        result, _ = self.run_browser([payload])
        self.assertEqual(result, (None, "LOGIN_UNVERIFIED"))

    def test_login_response_proves_success_despite_balance_api_outage(self):
        result, _ = self.run_browser([{"success": False, "error": "API_ERROR"}],
                                     {"success": True, "data": {"id": 17, "username": "dummy-user"}})
        self.assertEqual(result, ({"quota": None, "authenticated": True}, "SUCCESS"))

    def test_login_response_for_another_origin_never_proves_success(self):
        result, _ = self.run_browser([{"success": False}],
                                     {"success": True, "data": {"id": 17}},
                                     "https://foreign.test/api/user/login")
        self.assertEqual(result, (None, "USER_API_FAIL"))

    def test_default_port_and_host_case_do_not_hide_successful_login_evidence(self):
        for site, response_url in (("https://EXAMPLE.test:443", "https://example.test/api/user/login"),
                                   ("http://example.test:80", "http://example.test/api/user/login")):
            with self.subTest(site=site):
                result, _ = self.run_browser([{"success": False}],
                    {"success": True, "data": {"id": 17}}, response_url, account=dict(ACCOUNT, site=site))
                self.assertEqual(result, ({"quota": None, "authenticated": True}, "SUCCESS"))

    def test_pending_second_factor_never_proves_success(self):
        result, _ = self.run_browser([{"success": False}],
                                     {"success": True, "data": {"require_2fa": True}})
        self.assertEqual(result, (None, "USER_API_FAIL"))

    def test_login_response_identity_must_match_submitted_username(self):
        result, _ = self.run_browser([{"success": False}],
                                     {"success": True, "data": {"id": 17, "username": "another-user"}})
        self.assertEqual(result, (None, "USER_API_FAIL"))

    def test_modern_login_bundle_uses_dashboard_token_without_configured_api(self):
        result, page = self.run_browser([self_result()], {"success": True, "data": {
            "access_token": "dummy-session-token", "user": {"id": 17, "username": "dummy-user"}}})
        self.assertEqual(result[1], "SUCCESS")
        call = next(call for call in page.evaluate.call_args_list if "/api/user/self" in call.args[0])
        self.assertEqual(call.args[1]["access_token"], "dummy-session-token")

    def test_candidate_stops_on_proven_login_without_balance(self):
        with patch("account_observations.query_exit_ip", return_value="8.8.8.8"), \
                patch("account_observations.query_country", return_value={
                    "name": "US", "code": "US", "timezone_id": "America/New_York"}), \
                patch.object(app, "browser_login_complete", return_value=(
                {"quota": None, "authenticated": True}, "SUCCESS")) as login:
            result = app.checkin_assigned_account({}, [{"server": "http://one"}, {"server": "http://two"}], {})
        self.assertEqual(result, ({"quota": None, "authenticated": True}, "SUCCESS"))
        self.assertEqual(login.call_count, 1)

    def test_unavailable_balance_notification_does_not_claim_checkin_failure(self):
        for text in app.format_notifications([("dummy", None, "SUCCESS")], 1, 1):
            self.assertIn("登录成功", text)
            self.assertIn("未获取", text)
            self.assertNotIn("签到失败", text)

    def test_optional_management_api_reads_balance_only_after_independent_login(self):
        account = dict(ACCOUNT, api={"access_token": "dummy-management-token", "user_id": 17})
        result, page = self.run_browser([{"success": False}, self_result()],
            {"success": True, "data": {"id": 17}}, account=account)
        self.assertEqual(result, ({"quota": 500000, "user_group": "default"}, "SUCCESS"))
        calls = [call for call in page.evaluate.call_args_list if "/api/user/self" in call.args[0]]
        self.assertEqual(len(calls), 2)
        self.assertNotIn("access_token", calls[0].args[1])
        self.assertEqual(calls[1].args[1]["access_token"], "dummy-management-token")

    def test_optional_api_never_turns_failed_login_into_success(self):
        account = dict(ACCOUNT, api={"access_token": "dummy-management-token", "user_id": 17})
        result, page = self.run_browser([{"success": False}, self_result()], account=account)
        self.assertEqual(result, (None, "USER_API_FAIL"))
        self.assertEqual(sum("/api/user/self" in call.args[0] for call in page.evaluate.call_args_list), 1)

    def test_optional_api_for_another_account_is_not_requested(self):
        account = dict(ACCOUNT, api={"access_token": "dummy-management-token", "user_id": 18})
        result, page = self.run_browser([{"success": False}, self_result()],
            {"success": True, "data": {"id": 17}}, account=account)
        self.assertEqual(result, ({"quota": None, "authenticated": True}, "SUCCESS"))
        self.assertEqual(sum("/api/user/self" in call.args[0] for call in page.evaluate.call_args_list), 1)

    def test_optional_api_cannot_return_another_identity(self):
        account = dict(ACCOUNT, api={"access_token": "dummy-management-token", "user_id": 17})
        result, _ = self.run_browser([{"success": False}, self_result(user_id=18)],
            {"success": True, "data": {"id": 17}}, account=account)
        self.assertEqual(result, (None, "AUTH_IDENTITY_MISMATCH"))

    def test_keyless_balance_does_not_need_or_send_optional_token(self):
        account = dict(ACCOUNT, api={"access_token": "dummy-management-token", "user_id": 17})
        result, page = self.run_browser([self_result()], account=account)
        self.assertEqual(result[1], "SUCCESS")
        calls = [call for call in page.evaluate.call_args_list if "/api/user/self" in call.args[0]]
        self.assertEqual(len(calls), 1)
        self.assertNotIn("access_token", calls[0].args[1])


if __name__ == "__main__":
    unittest.main()
