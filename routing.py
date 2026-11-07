#!/usr/bin/env python3

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urldefrag, urlsplit, urlunsplit


DEFAULT_SITE = "https://agentrouter.org"
PASSWORD_KEY = "password"
MAX_CONFIG_BYTES = 48 * 1024
MAX_GROUPS = 256
MAX_CANDIDATES = 65535 - 18080 + 1
RUNNERS = {
    "ubuntu": "ubuntu-24.04",
    "windows": "windows-2022",
    "macos": "macos-14",
}
DIRECT_SCHEMES = {"vless", "vmess", "trojan", "hysteria2", "hy2", "socks5", "socks"}
ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
PROFILE_KEYS = {
    "viewport",
    "screen",
    "device_scale_factor",
    "locale",
    "timezone_id",
    "color_scheme",
}
DEFAULT_PROFILE = {
    "viewport": {"width": 1440, "height": 900},
    "screen": {"width": 1440, "height": 900},
    "device_scale_factor": 1,
    "locale": "zh-CN",
    "timezone_id": "Asia/Shanghai",
    "color_scheme": "light",
}


def _fail():
    raise ValueError("ROUTE_CONFIG_FAIL")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail()
        result[key] = value
    return result


def _nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def _https_url(value):
    if not _nonempty_string(value) or value != value.strip():
        _fail()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        _fail()
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or any(char.isspace() for char in parsed.hostname)
        or port is not None and not 1 <= port <= 65535
    ):
        _fail()
    return value


def normalize_site(value: str) -> str:
    if not _nonempty_string(value) or value != value.strip():
        _fail()
    source = value if "://" in value else f"https://{value}"
    try:
        parsed = urlsplit(source)
        port = parsed.port
    except (TypeError, ValueError):
        _fail()
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or any(char.isspace() for char in parsed.hostname)
        or port is not None and not 1 <= port <= 65535
    ):
        _fail()
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = host if port is None else f"{host}:{port}"
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path, "", ""))


def validate_webhook_url(value: str) -> bool:
    if not _nonempty_string(value) or value != value.strip():
        return False
    try:
        parsed = urlsplit(value)
        port = parsed.port
        query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme.lower() == "https"
        and parsed.hostname == "qyapi.weixin.qq.com"
        and parsed.username is None
        and parsed.password is None
        and port in (None, 443)
        and parsed.path == "/cgi-bin/webhook/send"
        and not parsed.fragment
        and set(query) == {"key"}
        and len(query["key"]) == 1
        and bool(query["key"][0])
    )


def _dimensions(value):
    if not isinstance(value, dict) or set(value) != {"width", "height"}:
        _fail()
    width, height = value["width"], value["height"]
    if type(width) is not int or type(height) is not int:
        _fail()
    if not 320 <= width <= 8192 or not 320 <= height <= 8192:
        _fail()
    return {"width": width, "height": height}


def _profile(value):
    if not isinstance(value, dict) or set(value) - PROFILE_KEYS:
        _fail()

    viewport = _dimensions(value.get("viewport", DEFAULT_PROFILE["viewport"]))
    if "screen" in value:
        screen = _dimensions(value["screen"])
    elif "viewport" in value:
        screen = dict(viewport)
    else:
        screen = dict(DEFAULT_PROFILE["screen"])
    if screen["width"] < viewport["width"] or screen["height"] < viewport["height"]:
        _fail()

    scale = value.get("device_scale_factor", 1)
    locale = value.get("locale", "zh-CN")
    timezone = value.get("timezone_id", "Asia/Shanghai")
    scheme = value.get("color_scheme", "light")
    if type(scale) is not int or scale not in {1, 2}:
        _fail()
    if locale not in {"zh-CN", "en-US"}:
        _fail()
    if timezone not in {
        "Asia/Shanghai",
        "Asia/Tokyo",
        "America/New_York",
        "Europe/London",
    }:
        _fail()
    if scheme not in {"light", "dark"}:
        _fail()
    return {
        "viewport": viewport,
        "screen": screen,
        "device_scale_factor": scale,
        "locale": locale,
        "timezone_id": timezone,
        "color_scheme": scheme,
    }


def _notifications(value):
    if not isinstance(value, dict) or set(value) - {"telegram", "wecom"}:
        _fail()
    result = {}
    if "telegram" in value:
        telegram = value["telegram"]
        if not isinstance(telegram, dict) or set(telegram) != {"bot_token", "chat_id"}:
            _fail()
        if not _nonempty_string(telegram["bot_token"]) or not _nonempty_string(telegram["chat_id"]):
            _fail()
        result["telegram"] = dict(telegram)
    if "wecom" in value:
        wecom = value["wecom"]
        if not isinstance(wecom, dict) or set(wecom) != {"webhook_url"}:
            _fail()
        if not validate_webhook_url(wecom["webhook_url"]):
            _fail()
        result["wecom"] = dict(wecom)
    return result


def _direct_link(value):
    if not _nonempty_string(value) or value != value.strip():
        _fail()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        _fail()
    if parsed.scheme.lower() not in DIRECT_SCHEMES:
        _fail()
    if parsed.scheme.lower() == "vmess":
        if not parsed.netloc and not parsed.path:
            _fail()
    elif not parsed.hostname or port is None or not 1 <= port <= 65535:
        _fail()
    return value


def _link_identity(value):
    link = urldefrag(value)[0]
    parsed = urlsplit(link)
    scheme = parsed.scheme.lower()
    if scheme == "vmess":
        return urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, ""))

    userinfo, separator, _ = parsed.netloc.rpartition("@")
    prefix = f"{userinfo}@" if separator else ""
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = f"{prefix}{host}:{parsed.port}"
    return urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))


def _proxy_list(value, subscription_url, references):
    if not isinstance(value, list) or not value:
        _fail()
    result = []
    for candidate in value:
        if not isinstance(candidate, dict) or len(candidate) != 1:
            _fail()
        if "node" in candidate:
            node = candidate["node"]
            if not _nonempty_string(node) or node != node.strip() or not subscription_url:
                _fail()
            reference = ("node", node)
            normalized = {"node": node}
        elif "link" in candidate:
            link = _direct_link(candidate["link"])
            reference = ("link", _link_identity(link))
            normalized = {"link": link}
        else:
            _fail()
        if reference in references:
            _fail()
        references.add(reference)
        result.append(normalized)
    return result


def build_manifest(accounts: list[dict]) -> dict:
    if not isinstance(accounts, list) or not accounts:
        _fail()
    ids = set()
    for account in accounts:
        if not isinstance(account, dict):
            _fail()
        account_id, os_name = account.get("id"), account.get("os")
        if not isinstance(account_id, str) or not ID_PATTERN.fullmatch(account_id):
            _fail()
        if account_id in ids or os_name not in RUNNERS:
            _fail()
        ids.add(account_id)

    groups = []
    for os_name, runner in RUNNERS.items():
        selected = sorted(
            (account for account in accounts if account["os"] == os_name),
            key=lambda account: account["id"],
        )
        for offset in range(0, len(selected), 3):
            groups.append(
                {
                    "group_id": f"g{len(groups) + 1:02}",
                    "os": runner,
                    "account_ids": [account["id"] for account in selected[offset : offset + 3]],
                    "mode": "isolated",
                }
            )
    if len(groups) > MAX_GROUPS:
        _fail()
    return {"version": 1, "groups": groups}


def parse_config(raw: str) -> dict:
    try:
        if not isinstance(raw, str) or not raw.strip() or len(raw.encode("utf-8")) > MAX_CONFIG_BYTES:
            _fail()
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=lambda _: _fail())
        if not isinstance(value, dict) or set(value) - {
            "version",
            "subscription_url",
            "notifications",
            "accounts",
        }:
            _fail()
        if type(value.get("version")) is not int or value["version"] != 1:
            _fail()
        accounts = value.get("accounts")
        if not isinstance(accounts, list) or not accounts:
            _fail()

        subscription_url = ""
        if "subscription_url" in value:
            subscription_url = _https_url(value["subscription_url"])
        notifications = _notifications(value["notifications"]) if "notifications" in value else {}

        normalized_accounts = []
        ids = set()
        login_records = set()
        references = set()
        candidate_count = 0
        required = {"id", "username", PASSWORD_KEY, "os", "proxies"}
        allowed = required | {"site", "profile"}
        for source in accounts:
            if not isinstance(source, dict) or not required <= set(source) or set(source) - allowed:
                _fail()
            account_id = source["id"]
            username = source["username"]
            secret = source[PASSWORD_KEY]
            os_name = source["os"]
            if not isinstance(account_id, str) or not ID_PATTERN.fullmatch(account_id) or account_id in ids:
                _fail()
            if not _nonempty_string(username) or not isinstance(secret, str) or not secret:
                _fail()
            if os_name not in RUNNERS:
                _fail()
            site = normalize_site(source.get("site", DEFAULT_SITE))
            login_record = (site, username)
            if login_record in login_records:
                _fail()
            proxies = _proxy_list(source["proxies"], subscription_url, references)
            candidate_count += len(proxies)
            if candidate_count > MAX_CANDIDATES:
                _fail()
            normalized_accounts.append(
                {
                    "id": account_id,
                    "site": site,
                    "username": username,
                    PASSWORD_KEY: secret,
                    "os": os_name,
                    "proxies": proxies,
                    "profile": _profile(source["profile"] if "profile" in source else {}),
                }
            )
            ids.add(account_id)
            login_records.add(login_record)

        build_manifest(normalized_accounts)
        return {
            "version": 1,
            "accounts": normalized_accounts,
            "subscription_url": subscription_url,
            "notifications": notifications,
        }
    except ValueError as error:
        if str(error) == "ROUTE_CONFIG_FAIL":
            raise
        _fail()
    except Exception:
        _fail()


def _legacy_manifest():
    from app import parse_accounts

    account_ids = [f"legacy{index:03d}" for index, _ in enumerate(parse_accounts(), start=1)]
    return {
        "version": 1,
        "groups": [
            {
                "group_id": "g01",
                "os": "ubuntu-24.04",
                "account_ids": account_ids,
                "mode": "legacy",
            }
        ],
    }


def _prepare(manifest_path):
    raw_present = "CHECKIN_CONFIG" in os.environ
    raw = os.environ.get("CHECKIN_CONFIG")
    mode = os.environ.get("CHECKIN_MODE", "")
    if mode not in {"", "isolated", "legacy"}:
        _fail()

    if raw:
        if mode == "legacy":
            _fail()
        manifest = build_manifest(parse_config(raw)["accounts"])
    else:
        if mode == "isolated" or raw_present and os.environ.get("GITHUB_ACTIONS") != "true":
            _fail()
        manifest = _legacy_manifest()

    path = Path(manifest_path)
    path.write_text(json.dumps(manifest, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    print("MANIFEST_READY")


def _matrix(manifest_path):
    from report import _load_manifest

    manifest = _load_manifest(Path(manifest_path))
    matrix = json.dumps({"include": [{"os": group["os"], "slot": index}
                                    for index, group in enumerate(manifest["groups"], 1)]},
                        ensure_ascii=True, separators=(",", ":"))
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as stream:
            stream.write(f"matrix={matrix}\n")
    else:
        print(f"matrix={matrix}")


def _assign(manifest_path, slot, runner):
    from report import _load_manifest

    manifest = _load_manifest(Path(manifest_path))
    output_path = os.environ.get("GITHUB_ENV")
    if not output_path or not 1 <= slot <= len(manifest["groups"]):
        _fail()
    group = manifest["groups"][slot - 1]
    if runner != group["os"]:
        _fail()
    values = {"GROUP_ID": group["group_id"], "CHECKIN_MODE": group["mode"], "RUNNER_KEY": runner,
              "ACCOUNT_IDS": json.dumps(group["account_ids"], ensure_ascii=True, separators=(",", ":"))}
    with open(output_path, "a", encoding="utf-8") as stream:
        stream.write("".join(f"{key}={value}\n" for key, value in values.items()))


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "matrix", "assign"):
        command = subparsers.add_parser(name)
        command.add_argument("--manifest", required=True)
        if name == "assign":
            command.add_argument("--slot", type=int, required=True)
            command.add_argument("--runner", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            _prepare(args.manifest)
        elif args.command == "matrix":
            _matrix(args.manifest)
        elif args.command == "assign":
            _assign(args.manifest, args.slot, args.runner)
        return 0
    except Exception:
        print("ROUTE_CONFIG_FAIL", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
