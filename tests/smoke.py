"""Native browser/proxy smoke using only loopback fixtures and dummy credentials."""

import base64
import json
import platform
import select
import socket
import socketserver
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app
from proxy_runtime import check_outbound, download_binary, group_proxy, parse_node_link
from routing import DEFAULT_PROFILE


LOGIN_PAGE = (Path(__file__).parent / "fixtures" / "login_options.html").read_bytes()


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests_seen += 1
        is_api = self.path == "/api/user/self"
        body = json.dumps({"success": True, "data": {"quota": 500000}}).encode() if is_api else LOGIN_PAGE
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if is_api else "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def read_exact(stream, size):
    result = b""
    while len(result) < size:
        chunk = stream.recv(size - len(result))
        if not chunk:
            raise ConnectionError("FIXTURE_CLOSED")
        result += chunk
    return result


class SocksFixture(socketserver.BaseRequestHandler):
    def handle(self):
        with self.server.lock:
            if self.server.stopping:
                return
            self.server.active.add(self.request)
        try:
            version, count = read_exact(self.request, 2)
            assert version == 5
            read_exact(self.request, count)
            self.request.sendall(b"\x05\x00")
            version, command, _, kind = read_exact(self.request, 4)
            assert version == 5 and command == 1
            if kind == 1:
                host = socket.inet_ntoa(read_exact(self.request, 4))
            elif kind == 3:
                host = read_exact(self.request, read_exact(self.request, 1)[0]).decode("ascii")
            else:
                raise ValueError("FIXTURE_ADDRESS")
            port = int.from_bytes(read_exact(self.request, 2), "big")
            # Never forward browser background traffic to an external destination.
            assert (host, port) == self.server.target
            with socket.create_connection(self.server.target, timeout=3) as upstream:
                self.server.connections_seen += 1
                self.request.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00")
                while True:
                    ready, _, _ = select.select([self.request, upstream], [], [], 5)
                    if not ready:
                        return
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(data)
        except (AssertionError, OSError, ValueError):
            return
        finally:
            with self.server.lock:
                self.server.active.discard(self.request)


class SocksServer(socketserver.ThreadingTCPServer):
    daemon_threads = True

    def __init__(self, *args):
        self.lock = threading.Lock()
        self.active = set()
        self.stopping = False
        super().__init__(*args)

    def disconnect(self):
        # Closing a listener does not close already accepted SOCKS tunnels.
        with self.lock:
            self.stopping = True
            active = tuple(self.active)
        for connection in active:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def check_browser_profile(endpoint):
    profile = dict(DEFAULT_PROFILE, locale="en-US", timezone_id="Europe/London",
                   viewport={"width": 1280, "height": 720}, screen={"width": 1920, "height": 1080},
                   device_scale_factor=2, color_scheme="dark")
    with app.sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, proxy={"server": endpoint},
                                             args=["--no-sandbox"])
        try:
            context = browser.new_context(**profile)
            page = context.new_page()
            page.set_content("""<nav><a href="/login">登录</a></nav>
                <div hidden><input id="username"><input type="password">
                <button>邮箱登录</button></div>
                <input name="email" style="visibility:hidden">
                <button style="visibility:hidden">邮箱登录</button>""")
            assert not app.wait_for_waf_ready(page, timeout_ms=100), "NAVIGATION_OR_HIDDEN_FORM_IS_NOT_READY"
            assert not app.click_email_login_button(page, timeout_ms=100), "HIDDEN_ENTRY_MUST_NOT_BE_CLICKED"
            for tag in ("a", "span", "div"):
                page.set_content(f"""<{tag} onclick="this.dataset.clicked='yes'">
                    使用 邮箱或用户名 登录</{tag}>""")
                assert app.click_email_login_button(page, timeout_ms=100), "LEGACY_ENTRY_FALLBACK_FAIL"
                assert page.locator('[data-clicked="yes"]').count() == 1, "LEGACY_ENTRY_NOT_CLICKED"
            values = page.evaluate("""() => ({
                platform: navigator.platform, ua: navigator.userAgent,
                locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                viewport: [innerWidth, innerHeight], screen: [screen.width, screen.height],
                scale: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches
            })""")
            prefix = {"Windows": "Win", "Darwin": "Mac", "Linux": "Linux"}[platform.system()]
            assert values.pop("platform").startswith(prefix), "BROWSER_OS_MISMATCH"
            assert "Chrome/" in values.pop("ua"), "BROWSER_UA_MISMATCH"
            assert values == {"locale": "en-US", "timezone": "Europe/London", "viewport": [1280, 720],
                              "screen": [1920, 1080], "scale": 2, "dark": True}, "BROWSER_PROFILE_MISMATCH"
        finally:
            browser.close()


def check_node_schemas(binary, directory):
    user_id = "12345678-1234-4234-8234-123456789abc"
    public_key = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    vmess = base64.b64encode(json.dumps({
        "v": "2", "add": "node.example", "port": "443", "id": user_id,
        "aid": "0", "net": "ws", "tls": "tls", "sni": "tls.example",
        "host": "ws.example", "path": "/socket?marker=dummy", "allowInsecure": "1",
    }).encode()).decode()
    links = [
        f"vless://{user_id}@node.example:443?encryption=none&security=tls&type=ws&host=ws.example&sni=tls.example&allowInsecure=1&ed=2048&eh=Sec-WebSocket-Protocol&path=%2F%3Fed%3D2048%26marker%3Done%26marker%3Dtwo",
        f"vless://{user_id}@node.example:443?security=tls&type=ws&path=%2Fsocket%3Fmarker%3Done%26marker%3Dtwo",
        f"vless://{user_id}@node.example:443?encryption=none&security=tls&type=grpc&serviceName=dummy",
        f"vless://{user_id}@node.example:443?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&pbk={public_key}&sid=0123456789abcdef&sni=tls.example&fp=chrome",
        "vmess://" + vmess,
        "trojan://dummy-password@node.example:443?type=ws&host=ws.example&path=%2Fsocket&sni=tls.example",
        "hy2://dummy-auth@node.example:443?sni=tls.example&obfs=salamander&obfs-password=dummy-obfs",
        "socks5://dummy-user:dummy-password@node.example:1080",
    ]
    # Native -test builds the schema only: it starts no listeners or node connections.
    for index, link in enumerate(links):
        outbound = parse_node_link(link, f"schema{index}")
        assert check_outbound(outbound, binary, directory), f"XRAY_SCHEMA_FAIL_{index}"


def main():
    fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    fixture.requests_seen = 0
    socks = SocksServer(("127.0.0.1", 0), SocksFixture)
    socks.target = fixture.server_address
    socks.connections_seen = 0
    for server in (fixture, socks):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="checkin-smoke-") as directory:
            binary = download_binary(platform.system(), platform.machine(), Path(directory))
            check_node_schemas(binary, Path(directory))
            outbounds = {"a01_p01": {
                "type": "socks", "server": "127.0.0.1",
                "server_port": socks.server_address[1], "version": "5",
            }}
            with group_proxy(outbounds, binary, Path(directory)) as endpoints:
                endpoint = endpoints["a01_p01"]
                check_browser_profile(endpoint)
                account = {"site": f"http://127.0.0.1:{fixture.server_address[1]}",
                           "username": "smoke-user", "password": "smoke-secret"}
                result, stage = app.browser_login_complete(
                    account, proxy={"server": endpoint}, profile=DEFAULT_PROFILE, isolated=True
                )
                assert stage == "SUCCESS" and result["quota"] == 500000, stage
                assert socks.connections_seen > 0, "BROWSER_BYPASSED_ASSIGNED_PROXY"
                socks.disconnect()
                socks.shutdown()
                socks.server_close()
                before = fixture.requests_seen
                with app.requests.Session() as session:
                    session.trust_env = False
                    try:
                        response = session.get(account["site"], proxies={"http": endpoint, "https": endpoint}, timeout=3)
                        # Xray may return HTTP 503 instead of closing a failed proxy request.
                        response.raise_for_status()
                    except app.requests.RequestException:
                        pass
                    else:
                        raise AssertionError("UNLISTED_DIRECT_FALLBACK")
                assert fixture.requests_seen == before
        print(f"PASS native {platform.system()}: isolated fixture login and no direct fallback")
    finally:
        socks.shutdown()
        socks.server_close()
        fixture.shutdown()
        fixture.server_close()


if __name__ == "__main__":
    main()
