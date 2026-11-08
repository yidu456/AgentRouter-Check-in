#!/usr/bin/env python3

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urldefrag, urlsplit, urlunsplit


DEFAULT_SITE = "https://agentrouter.org"
PASSWORD_KEY = "password"
MAX_CONFIG_BYTES = 48 * 1024
MAX_GROUPS = 256
MAX_CANDIDATES = 65535 - 18080 + 1
RUNNERS = {
    "ubuntu": "ubuntu-24.04",
    "windows": "windows-2022",
    "macos": "macos-15",
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


DIAGNOSTIC_REASONS = set("""INVALID FIELDS_INVALID NONEMPTY_STRING URL_INVALID INVALID_CHOICE
    INTEGER_REQUIRED INTEGER_RANGE SCREEN_SMALLER_THAN_VIEWPORT JSON_INVALID JSON_DUPLICATE_KEY
    JSON_NONFINITE CONFIG_REQUIRED CONFIG_TOO_LARGE DUPLICATE_ID DUPLICATE_LOGIN DUPLICATE_PROXY
    OS_INHERITED_FROM_GROUP SUBSCRIPTION_REQUIRED SUBSCRIPTION_REQUEST_FAIL SUBSCRIPTION_HTTP_ERROR
    SUBSCRIPTION_READ_FAIL SUBSCRIPTION_TOO_LARGE SUBSCRIPTION_FORMAT_INVALID SUBSCRIPTION_NO_VALID_NODES
    SUBSCRIPTION_DUPLICATE_NODE_NAME SUBSCRIPTION_CLOSE_FAIL POOL_INVALID POOL_STATS POOL_CAPACITY_STATS
    POOL_TOO_SMALL FIXED_LINK_INVALID FIXED_NODE_DUPLICATE FIXED_NODE_MISSING POOL_PLAN_FAIL
    MANIFEST_WRITE_FAIL""".split())
DIAGNOSTIC_FIELDS = set("""config version subscription_url notifications telegram wecom bot_token chat_id
    webhook_url groups ubuntu macos windows accounts id username password os site proxies link node random
    profile viewport screen width height device_scale_factor locale timezone_id color_scheme api access_token
    user_id manifest mode""".split())
DIAGNOSTIC_NUMBERS = ("status", "line", "column", "total", "valid", "rejected", "duplicate", "distinct",
                      "excluded", "available", "requested", "account_index", "proxy_index")


def format_diagnostic(value):
    value = value if isinstance(value, dict) else {}
    field, reason = value.get("field"), value.get("reason")
    if (not isinstance(field, str) or len(field) > 256
            or re.fullmatch(r"[a-z_]+(?:\[[0-9]{1,6}\])?(?:\.[a-z_]+(?:\[[0-9]{1,6}\])?)*", field) is None
            or any(part not in DIAGNOSTIC_FIELDS for part in re.findall(r"[a-z_]+", field))):
        field = "config"
    if not isinstance(reason, str) or reason not in DIAGNOSTIC_REASONS:
        reason = "INVALID"
    parts = ["PREPARE_DIAGNOSTIC", f"field={field}", f"reason={reason}"]
    for key in DIAGNOSTIC_NUMBERS:
        number = value.get(key)
        if type(number) is int and 0 <= number < 2**31 and (key != "status" or 100 <= number <= 599):
            parts.append(f"{key}={number}")
    return " ".join(parts)


def _fail(reason="INVALID", field="config", **numbers):
    error = ValueError("ROUTE_CONFIG_FAIL")
    error.diagnostic = {"field": field, "reason": reason, **numbers}
    raise error


def _at(field, function, *args):
    try:
        return function(*args)
    except ValueError as error:
        if str(error) != "ROUTE_CONFIG_FAIL":
            _fail(field=field)
        detail = dict(getattr(error, "diagnostic", {}))
        child = detail.get("field", "config")
        detail["field"] = field if child == "config" else field + ("" if child.startswith("[") else ".") + child
        error.diagnostic = detail
        raise
    except Exception:
        _fail(field=field)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("JSON_DUPLICATE_KEY")
        result[key] = value
    return result


def _nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def _https_url(value):
    if not _nonempty_string(value) or value != value.strip():
        _fail("URL_INVALID")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        _fail("URL_INVALID")
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or any(char.isspace() for char in parsed.hostname)
        or port is not None and not 1 <= port <= 65535
    ):
        _fail("URL_INVALID")
    return value


def normalize_site(value: str) -> str:
    if not _nonempty_string(value) or value != value.strip():
        _fail("URL_INVALID")
    source = value if "://" in value else f"https://{value}"
    try:
        parsed = urlsplit(source)
        port = parsed.port
    except (TypeError, ValueError):
        _fail("URL_INVALID")
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
        _fail("URL_INVALID")
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
        _fail("FIELDS_INVALID")
    width, height = value["width"], value["height"]
    for field, dimension in (("width", width), ("height", height)):
        if type(dimension) is not int:
            _fail("INTEGER_REQUIRED", field)
        if not 320 <= dimension <= 8192:
            _fail("INTEGER_RANGE", field)
    return {"width": width, "height": height}


def _profile(value):
    if not isinstance(value, dict) or set(value) - PROFILE_KEYS:
        _fail("FIELDS_INVALID")

    viewport = _at("viewport", _dimensions, value.get("viewport", DEFAULT_PROFILE["viewport"]))
    if "screen" in value:
        screen = _at("screen", _dimensions, value["screen"])
    elif "viewport" in value:
        screen = dict(viewport)
    else:
        screen = dict(DEFAULT_PROFILE["screen"])
    if screen["width"] < viewport["width"] or screen["height"] < viewport["height"]:
        _fail("SCREEN_SMALLER_THAN_VIEWPORT", "screen")

    scale = value.get("device_scale_factor", 1)
    locale = value.get("locale", "zh-CN")
    timezone = value.get("timezone_id", "Asia/Shanghai")
    scheme = value.get("color_scheme", "light")
    if type(scale) is not int or scale not in {1, 2}:
        _fail("INVALID_CHOICE", "device_scale_factor")
    if not isinstance(locale, str) or locale not in {"zh-CN", "en-US"}:
        _fail("INVALID_CHOICE", "locale")
    if not isinstance(timezone, str) or timezone not in {
        "Asia/Shanghai",
        "Asia/Tokyo",
        "America/New_York",
        "Europe/London",
        "Asia/Singapore",
        "Asia/Seoul",
        "Europe/Berlin",
        "Asia/Hong_Kong",
    }:
        _fail("INVALID_CHOICE", "timezone_id")
    if not isinstance(scheme, str) or scheme not in {"light", "dark"}:
        _fail("INVALID_CHOICE", "color_scheme")
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
        _fail("FIELDS_INVALID")
    result = {}
    if "telegram" in value:
        telegram = value["telegram"]
        if not isinstance(telegram, dict) or set(telegram) != {"bot_token", "chat_id"}:
            _fail("FIELDS_INVALID", "telegram")
        for field in ("bot_token", "chat_id"):
            if not _nonempty_string(telegram[field]):
                _fail("NONEMPTY_STRING", "telegram." + field)
        result["telegram"] = dict(telegram)
    if "wecom" in value:
        wecom = value["wecom"]
        if not isinstance(wecom, dict) or set(wecom) != {"webhook_url"}:
            _fail("FIELDS_INVALID", "wecom")
        if not validate_webhook_url(wecom["webhook_url"]):
            _fail("URL_INVALID", "wecom.webhook_url")
        result["wecom"] = dict(wecom)
    return result


def _api(value):
    if not isinstance(value, dict) or set(value) != {"access_token", "user_id"}:
        _fail("FIELDS_INVALID")
    token, user_id = value["access_token"], value["user_id"]
    if (
        not isinstance(token, str)
        or not 1 <= len(token) <= 4096
        or any(not 0x21 <= ord(char) <= 0x7E for char in token)
    ):
        _fail("INVALID_CHOICE", "access_token")
    if type(user_id) is not int or not 1 <= user_id <= 2 ** 53 - 1:
        _fail("INTEGER_RANGE", "user_id")
    return {"access_token": token, "user_id": user_id}


def _direct_link(value):
    if not _nonempty_string(value) or value != value.strip():
        _fail("URL_INVALID")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        _fail("URL_INVALID")
    if parsed.scheme.lower() not in DIRECT_SCHEMES:
        _fail("URL_INVALID")
    if parsed.scheme.lower() == "vmess":
        if not parsed.netloc and not parsed.path:
            _fail("URL_INVALID")
    elif not parsed.hostname or port is None or not 1 <= port <= 65535:
        _fail("URL_INVALID")
    return value


def normalize_vless_ws_link(value):
    parsed = urlsplit(value)
    if parsed.scheme.lower() != "vless" or re.search(r"%(?![0-9a-fA-F]{2})", parsed.query):
        return value
    try:
        query = parse_qs(parsed.query, keep_blank_values=True, errors="strict")
    except ValueError:
        return value
    # Leave malformed queries intact so the original parser rejects them before removal.
    if any(len(values) != 1 for values in query.values()):
        return value
    if query.get("security") != ["tls"] or query.get("type") != ["ws"]:
        return value
    fields = sorted((key, values[0]) for key, values in query.items() if key not in {"fp", "ech"})
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(fields), parsed.fragment))


def _link_identity(value):
    link = urldefrag(normalize_vless_ws_link(value))[0]
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
        _fail("FIELDS_INVALID")
    result = []
    for index, candidate in enumerate(value):
        position = f"[{index}]"
        if not isinstance(candidate, dict) or len(candidate) != 1:
            _fail("FIELDS_INVALID", position)
        if "node" in candidate:
            node = candidate["node"]
            if not _nonempty_string(node) or node != node.strip():
                _fail("NONEMPTY_STRING", position + ".node")
            if not subscription_url:
                _fail("SUBSCRIPTION_REQUIRED", position + ".node")
            reference = ("node", node)
            normalized = {"node": node}
        elif "link" in candidate:
            link = _at(position + ".link", _direct_link, candidate["link"])
            reference = ("link", _link_identity(link))
            normalized = {"link": link}
        elif "random" in candidate:
            count = candidate["random"]
            if type(count) is not int or not 1 <= count <= MAX_CANDIDATES:
                _fail("INTEGER_RANGE", position + ".random")
            if not subscription_url:
                _fail("SUBSCRIPTION_REQUIRED", position + ".random")
            result.append({"random": count})
            continue
        else:
            _fail("FIELDS_INVALID", position)
        if reference in references:
            _fail("DUPLICATE_PROXY", position + (".link" if "link" in candidate else ".node"))
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
        if not isinstance(raw, str) or not raw.strip():
            _fail("CONFIG_REQUIRED")
        if len(raw.encode("utf-8")) > MAX_CONFIG_BYTES:
            _fail("CONFIG_TOO_LARGE")
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=lambda _: _fail("JSON_NONFINITE"))
    except json.JSONDecodeError as error:
        _fail("JSON_INVALID", line=error.lineno, column=error.colno)
    except ValueError as error:
        if str(error) == "ROUTE_CONFIG_FAIL":
            raise
        _fail("JSON_INVALID")
    except Exception:
        _fail("JSON_INVALID")
    return _normalize_config(value)


def _normalize_config(value: dict) -> dict:
    # Internal revalidation must not charge inherited OS or expanded defaults as raw JSON.
    try:
        if not isinstance(value, dict):
            _fail("FIELDS_INVALID")
        version = value.get("version")
        if type(version) is not int or version not in {1, 2}:
            _fail("INVALID_CHOICE", "version")
        account_field = "accounts" if version == 1 else "groups"
        if set(value) - {"version", "subscription_url", "notifications", account_field}:
            _fail("FIELDS_INVALID")
        paths = []
        if version == 1:
            accounts = value.get("accounts")
            if isinstance(accounts, list):
                paths = [f"accounts[{index}]" for index in range(len(accounts))]
        else:
            os_groups = value.get("groups")
            if not isinstance(os_groups, dict) or set(os_groups) - RUNNERS.keys():
                _fail("FIELDS_INVALID", "groups")
            accounts = []
            for os_name in RUNNERS:
                if os_name not in os_groups:
                    continue
                group = os_groups[os_name]
                field = f"groups.{os_name}"
                if not isinstance(group, dict) or set(group) != {"accounts"}:
                    _fail("FIELDS_INVALID", field)
                if not isinstance(group["accounts"], list):
                    _fail("FIELDS_INVALID", field + ".accounts")
                for index, source in enumerate(group["accounts"]):
                    path = f"{field}.accounts[{index}]"
                    if not isinstance(source, dict):
                        _fail("FIELDS_INVALID", path)
                    if "os" in source:
                        _fail("OS_INHERITED_FROM_GROUP", path + ".os")
                    accounts.append({**source, "os": os_name})
                    paths.append(path)
        if not isinstance(accounts, list) or not accounts:
            _fail("FIELDS_INVALID", account_field)

        subscription_url = ""
        if "subscription_url" in value:
            subscription_url = _at("subscription_url", _https_url, value["subscription_url"])
        notifications = _at("notifications", _notifications, value["notifications"]) if "notifications" in value else {}

        normalized_accounts = []
        ids = set()
        login_records = set()
        references = set()
        candidate_count = 0
        required = {"id", "username", PASSWORD_KEY, "os", "proxies"}
        allowed = required | {"site", "profile", "api"}
        for path, source in zip(paths, accounts):
            if not isinstance(source, dict) or set(source) - allowed:
                _fail("FIELDS_INVALID", path)
            missing = required - set(source)
            if missing:
                _fail("FIELDS_INVALID", path + "." + sorted(missing)[0])
            account_id = source["id"]
            username = source["username"]
            secret = source[PASSWORD_KEY]
            os_name = source["os"]
            if not isinstance(account_id, str) or not ID_PATTERN.fullmatch(account_id):
                _fail("INVALID_CHOICE", path + ".id")
            if account_id in ids:
                _fail("DUPLICATE_ID", path + ".id")
            if not _nonempty_string(username):
                _fail("NONEMPTY_STRING", path + ".username")
            if not isinstance(secret, str) or not secret:
                _fail("NONEMPTY_STRING", path + "." + PASSWORD_KEY)
            if not isinstance(os_name, str) or os_name not in RUNNERS:
                _fail("INVALID_CHOICE", path + ".os")
            site = _at(path + ".site", normalize_site, source.get("site", DEFAULT_SITE))
            login_record = (site, username)
            if login_record in login_records:
                _fail("DUPLICATE_LOGIN", path + ".username")
            proxies = _at(path + ".proxies", _proxy_list, source["proxies"], subscription_url, references)
            candidate_count += sum(candidate.get("random", 1) for candidate in proxies)
            if candidate_count > MAX_CANDIDATES:
                _fail("INTEGER_RANGE", path + ".proxies")
            normalized_account = {
                "id": account_id,
                "site": site,
                "username": username,
                PASSWORD_KEY: secret,
                "os": os_name,
                "proxies": proxies,
                "profile": _at(path + ".profile", _profile, source["profile"] if "profile" in source else {}),
            }
            if "api" in source:
                normalized_account["api"] = _at(path + ".api", _api, source["api"])
            normalized_accounts.append(normalized_account)
            ids.add(account_id)
            login_records.add(login_record)

        build_manifest(normalized_accounts)
        # Runtime consumers and random-pool fingerprints keep the v1 account contract.
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
        _fail("INVALID_CHOICE", "mode")

    if raw:
        if mode == "legacy":
            _fail("INVALID_CHOICE", "mode")
        config = parse_config(raw)
        print(f"PREPARE_CONFIG_OK accounts={len(config['accounts'])}")
        manifest = build_manifest(config["accounts"])
        from subscription_pool import has_random, load_pool, make_plan

        if has_random(config["accounts"]):
            print("PREPARE_SUBSCRIPTION_START")
            require_names = any("node" in p for a in config["accounts"] for p in a["proxies"])
            names, nodes = load_pool(config["subscription_url"], require_names=require_names, diagnostics=True)
            manifest["random"] = make_plan(config, names, nodes, diagnostics=True)
    else:
        if mode == "isolated" or raw_present and os.environ.get("GITHUB_ACTIONS") != "true":
            _fail("CONFIG_REQUIRED")
        manifest = _legacy_manifest()

    try:
        path = Path(manifest_path)
        path.write_text(json.dumps(manifest, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    except OSError:
        _fail("MANIFEST_WRITE_FAIL", "manifest")
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
    if "random" in manifest:
        values["RANDOM_PLAN"] = json.dumps(manifest["random"], separators=(",", ":"))
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
    except Exception as error:
        print("ROUTE_CONFIG_FAIL", file=sys.stderr)
        if args.command == "prepare":
            print(format_diagnostic(getattr(error, "diagnostic", None)), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
