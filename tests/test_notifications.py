import unittest
from unittest.mock import Mock, patch

import app


WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-test"


class NotificationTests(unittest.TestCase):
    def test_wecom_success(self):
        response = Mock(status_code=200)
        response.json.return_value = {"errcode": 0}
        with patch.object(app.requests, "post", return_value=response) as post:
            self.assertTrue(app.send_wecom("balance $1.00", WEBHOOK))
        post.assert_called_once_with(
            WEBHOOK,
            json={"msgtype": "text", "text": {"content": "balance $1.00"}},
            timeout=30,
            allow_redirects=False,
        )

    def test_wecom_rejections(self):
        for payload in ({"errcode": 1}, {"errcode": False}, {}, [], "bad"):
            with self.subTest(payload=payload):
                response = Mock(status_code=200)
                response.json.return_value = payload
                with patch.object(app.requests, "post", return_value=response) as post:
                    self.assertFalse(app.send_wecom("summary", WEBHOOK))
                self.assertEqual(post.call_count, 1)

    def test_redirect_and_network_failure_are_not_retried(self):
        with patch.object(app.requests, "post", return_value=Mock(status_code=302)) as post:
            self.assertFalse(app.send_wecom("summary", WEBHOOK))
            self.assertEqual(post.call_count, 1)
        with patch.object(app.requests, "post", side_effect=RuntimeError("private-token")) as post:
            self.assertFalse(app.send_wecom("summary", WEBHOOK))
            self.assertEqual(post.call_count, 1)

    def test_invalid_webhook_makes_no_request(self):
        for url in ("", "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a",
                    WEBHOOK + "&extra=a", WEBHOOK + "#secret",
                    "https://evil.example/cgi-bin/webhook/send?key=a"):
            with self.subTest(url=url), patch.object(app.requests, "post") as post:
                self.assertFalse(app.send_wecom("summary", url))
                post.assert_not_called()

    def test_utf8_chunks_preserve_text_and_lines(self):
        for message in ("", "a" * 2048, "a" * 2049,
                        "\u7b7e\u5230\U0001f381" * 900,
                        "a" * 1000 + "\n" + "b" * 1500):
            with self.subTest(length=len(message)):
                chunks = app.split_utf8_text(message)
                self.assertEqual("".join(chunks), message)
                self.assertTrue(all(0 < len(c.encode("utf-8")) <= 2048 for c in chunks))
        self.assertEqual(app.split_utf8_text("a" * 1000 + "\n" + "b" * 1500)[0],
                         "a" * 1000 + "\n")

    def test_pacing_and_empty_text(self):
        response = Mock(status_code=200)
        response.json.return_value = {"errcode": 0}
        with patch.object(app.requests, "post", return_value=response) as post, \
                patch.object(app.time, "sleep") as sleep:
            self.assertFalse(app.send_wecom("", WEBHOOK))
            self.assertTrue(app.send_wecom("a" * 5000, WEBHOOK))
        self.assertEqual(post.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        sleep.assert_called_with(3.1)

    def test_json_disabled_channels_do_not_inherit_legacy(self):
        with patch.object(app, "TG_BOT_TOKEN", "old-token"), \
                patch.object(app, "TG_CHAT_ID", "old-chat"), \
                patch.object(app, "send_telegram") as telegram, \
                patch.object(app, "send_wecom") as wecom:
            self.assertEqual(app.send_notifications("html", "text", config={}),
                             {"telegram": None, "wecom": None})
        telegram.assert_not_called()
        wecom.assert_not_called()

    def test_independent_dispatch(self):
        config = {"telegram": {"bot_token": "token", "chat_id": "chat"},
                  "wecom": {"webhook_url": WEBHOOK}}
        with patch.object(app, "send_telegram", side_effect=RuntimeError("private")) as telegram, \
                patch.object(app, "send_wecom", return_value=True) as wecom:
            self.assertEqual(app.send_notifications("html", "text", config),
                             {"telegram": False, "wecom": True})
        telegram.assert_called_once_with("html", token="token", chat_id="chat")
        wecom.assert_called_once_with("text", WEBHOOK)

    def test_explicit_empty_telegram_does_not_inherit_token(self):
        with patch.object(app, "TG_BOT_TOKEN", "old-token"), \
                patch.object(app, "TG_CHAT_ID", "old-chat"), \
                patch.object(app.requests, "post") as post:
            self.assertFalse(app.send_telegram("summary", token="", chat_id=""))
        post.assert_not_called()

    def test_large_telegram_summary_is_split_after_aggregation(self):
        response = Mock(status_code=200)
        response.json.return_value = {"ok": True}
        text = "line balance $1.00\n" * 500
        with patch.object(app.requests, "post", return_value=response) as post, \
                patch.object(app.time, "sleep"):
            self.assertTrue(app.send_telegram(text, token="unit", chat_id="unit"))
        pieces = [call.kwargs["json"]["text"] for call in post.call_args_list]
        self.assertGreater(len(pieces), 1)
        self.assertEqual("".join(pieces), text)
        self.assertTrue(all(len(piece.encode("utf-8")) <= 3500 for piece in pieces))

    def test_telegram_api_rejection_is_not_success(self):
        response = Mock(status_code=200)
        response.json.return_value = {"ok": False}
        with patch.object(app.requests, "post", return_value=response):
            self.assertFalse(app.send_telegram("summary", token="unit", chat_id="unit"))

    def test_separate_formatting(self):
        html, plain = app.format_notifications(
            [("a<&", "$1.00", ""), ("a02", None, "PROXY_LIST_EXHAUSTED")], 1, 2
        )
        self.assertIn("a&lt;&amp;", html)
        self.assertIn("a<&", plain)
        self.assertNotIn("<b>", plain)
        self.assertIn("PROXY_LIST_EXHAUSTED", plain)
        self.assertIn("1/2", plain)


if __name__ == "__main__":
    unittest.main()
