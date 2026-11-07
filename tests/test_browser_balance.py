"""Real Chromium, loopback-only HTTP, and dummy account credentials."""

import contextlib
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import app
from playwright.sync_api import sync_playwright
from routing import PASSWORD_KEY


USER = {"id": 1, "username": "smoke-user", "quota": 500000, "group": "default"}
LOGIN_PAGE = (Path(__file__).parent / "fixtures" / "login_options.html").read_text(encoding="utf-8").replace(
    "localStorage.setItem('user', JSON.stringify({id: 1}));",
    "fetch('/api/user/login', {method: 'POST'}).then(r => r.json()).then(payload => {"
    "if (payload.success && payload.data.id) localStorage.setItem('user', JSON.stringify(payload.data));});",
)


class Fixture(BaseHTTPRequestHandler):
    def respond(self, status, body, content_type="application/json"):
        body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", "fixture_session=valid; HttpOnly; SameSite=Lax")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        data = USER if self.server.mode != "modern" else {"access_token": "dummy-browser-token", "user": USER}
        self.respond(200, json.dumps({"success": True, "data": data}))

    def do_GET(self):
        if self.path != "/api/user/self":
            self.respond(200, LOGIN_PAGE, "text/html")
            return
        self.server.headers_seen.append(dict(self.headers))
        if self.server.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "https://blocked.example.test/steal")
            self.end_headers()
            return
        token = self.headers.get("Authorization")
        accepted = (self.server.mode == "cookie" and "fixture_session=valid" in self.headers.get("Cookie", "")
                    or self.server.mode == "modern" and token == "Bearer dummy-browser-token"
                    or self.server.mode == "fallback" and token == "Bearer dummy-management-token")
        accepted = accepted and self.headers.get("New-API-User") == "1"
        self.respond(200 if accepted else 503, json.dumps({"success": bool(accepted), "data": USER if accepted else None}))

    def log_message(self, *args):
        pass


class BrowserBalanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with sync_playwright() as playwright:
            if not Path(playwright.chromium.executable_path).is_file():
                raise unittest.SkipTest("Install Playwright Chromium for the offline browser regression")

    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        self.server.mode = "cookie"
        self.server.headers_seen = []
        self.site = f"http://127.0.0.1:{self.server.server_port}"
        self.external = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.assertEqual(self.external, [])

    @contextlib.contextmanager
    def fixture_browser(self):
        with sync_playwright() as playwright:
            def launch(**options):
                browser = playwright.chromium.launch(**options)
                new_context = browser.new_context

                def context(**settings):
                    context = new_context(**settings)

                    def route(request_route):
                        if request_route.request.url.startswith(self.site + "/"):
                            request_route.continue_()
                        else:
                            self.external.append(request_route.request.url)
                            request_route.abort()

                    context.route("**/*", route)
                    new_page = context.new_page

                    def page():
                        page = new_page()
                        wait = page.wait_for_timeout
                        page.wait_for_timeout = lambda milliseconds: wait(min(milliseconds, 50))
                        return page

                    context.new_page = page
                    return context

                browser.new_context = context
                return browser

            yield SimpleNamespace(chromium=SimpleNamespace(launch=launch))

    def login(self, api=None):
        account = {"site": self.site, "username": "smoke-user", PASSWORD_KEY: "dummy-secret"}
        if api:
            account["api"] = api
        with patch.object(app, "sync_playwright", self.fixture_browser), patch.object(app, "PROXY_SERVER", ""):
            return app.browser_login_complete(account)

    def test_browser_cookie_and_user_header_read_keyless_balance(self):
        self.assertEqual(self.login(), ({"quota": 500000}, "SUCCESS"))
        self.assertEqual(len(self.server.headers_seen), 1)
        self.assertEqual(self.server.headers_seen[0]["New-API-User"], "1")
        self.assertNotIn("Authorization", self.server.headers_seen[0])

    def test_modern_session_token_is_reused_without_local_storage_user(self):
        self.server.mode = "modern"
        self.assertEqual(self.login(), ({"quota": 500000}, "SUCCESS"))
        self.assertEqual(self.server.headers_seen[0]["Authorization"], "Bearer dummy-browser-token")

    def test_configured_management_token_is_only_a_second_balance_attempt(self):
        self.server.mode = "fallback"
        self.assertEqual(self.login({"access_token": "dummy-management-token", "user_id": 1}),
                         ({"quota": 500000}, "SUCCESS"))
        self.assertEqual(len(self.server.headers_seen), 2)
        self.assertNotIn("Authorization", self.server.headers_seen[0])
        self.assertEqual(self.server.headers_seen[1]["Authorization"], "Bearer dummy-management-token")

    def test_redirect_never_forwards_credentials_and_login_stays_proven(self):
        self.server.mode = "redirect"
        self.assertEqual(self.login({"access_token": "dummy-management-token", "user_id": 1}),
                         ({"quota": None, "authenticated": True}, "SUCCESS"))
        self.assertEqual(len(self.server.headers_seen), 2)

    def test_unexpected_page_origin_never_sends_management_token(self):
        with self.fixture_browser() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_context().new_page()
                page.goto(self.site + "/login")
                result = app._browser_self(page, "http://127.0.0.1:1", {
                    "user_id": 1, "access_token": "dummy-management-token",
                })
                self.assertEqual(result, {"success": False})
                self.assertEqual(self.server.headers_seen, [])
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
