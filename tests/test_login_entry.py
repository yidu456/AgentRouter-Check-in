import re
import unittest
from unittest.mock import MagicMock, patch

import app


class EntryLocator:
    def __init__(self, page, labels):
        self.page = page
        self.labels = labels
        self.first = self

    def wait_for(self, **kwargs):
        if not self.labels or self.labels[0] in self.page.hidden:
            raise RuntimeError("not visible")

    def click(self, **kwargs):
        self.wait_for()
        self.page.clicked.append(self.labels[0])


class EntryPage:
    def __init__(self, labels, hidden=()):
        self.labels = labels
        self.hidden = hidden
        self.clicked = []

    def get_by_text(self, text):
        if isinstance(text, re.Pattern):
            matches = [label for label in self.labels if text.search(label)]
        else:
            matches = [label for label in self.labels if text in label]
        return EntryLocator(self, matches)

    def get_by_role(self, role, name):
        return self.get_by_text(name)

    def evaluate(self, *args):
        return False


class LoginEntryTests(unittest.TestCase):
    def test_current_chinese_entry_with_spaces_and_no_spaces(self):
        for label in ("使用 邮箱或用户名 登录", "使用邮箱或用户名登录", "使用\n邮箱或用户名\n登录"):
            with self.subTest(label=label):
                page = EntryPage(["登录", "注册", label])
                self.assertTrue(app.click_email_login_button(page))
                self.assertEqual(page.clicked, [label])

    def test_existing_english_and_chinese_aliases(self):
        for label in ("Sign in with Email or Username", "Email or Username", "Sign in with Email",
                      "账号登录", "邮箱登录", "密码登录"):
            with self.subTest(label=label):
                page = EntryPage(["Sign In", label])
                self.assertTrue(app.click_email_login_button(page))
                self.assertEqual(page.clicked, [label])

    def test_entry_lookup_uses_one_shared_regex_instead_of_sequential_text_waits(self):
        page = MagicMock()
        self.assertTrue(app.click_email_login_button(page))
        page.get_by_text.assert_not_called()
        name = page.get_by_role.call_args.kwargs["name"]
        self.assertIsInstance(name, re.Pattern)
        self.assertIsNotNone(name.search("使用 邮箱或用户名 登录"))
        page.get_by_role.assert_called_once_with("button", name=name)

    def test_generic_navigation_and_hidden_entries_do_not_get_clicked(self):
        for labels, hidden in ((["登录", "Sign In", "Log In", "注册"], ()),
                               (["邮箱登录"], ("邮箱登录",))):
            with self.subTest(labels=labels):
                page = EntryPage(labels, hidden)
                self.assertFalse(app.click_email_login_button(page))
                self.assertEqual(page.clicked, [])

    def test_waf_readiness_passes_shared_entry_pattern_to_dom_check(self):
        page = MagicMock()
        page.evaluate.return_value = {"hasLoginForm": False, "hasLoginButton": True, "isChallenge": False}
        self.assertTrue(app.wait_for_waf_ready(page, timeout_ms=1000))
        self.assertEqual(len(page.evaluate.call_args.args), 2)
        pattern = page.evaluate.call_args.args[1]
        self.assertIsNotNone(re.search(pattern, "使用 邮箱或用户名 登录", re.I))
        self.assertIsNone(re.search(pattern, "登录", re.I))


if __name__ == "__main__":
    unittest.main()
