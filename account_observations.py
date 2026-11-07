"""Bounded proxy observations and identity-bound, quota-only history."""

import copy
import hashlib
import ipaddress
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit


MAX_QUOTA = 2**63 - 1
MAX_HISTORY_BYTES = 1024 * 1024
MAX_HISTORY_ENTRIES = 768
MAX_IP_BYTES = 128
MAX_COUNTRY_BYTES = 4096
HISTORY_KEY_PATTERN = re.compile(r"[0-9a-f]{64}\Z")


def _empty_history():
    return {"version": 1, "balances": {}}


def _valid_quota(value):
    return type(value) is int and 0 <= value <= MAX_QUOTA


def _validated_history(value):
    if (
        not isinstance(value, dict)
        or set(value) != {"version", "balances"}
        or type(value["version"]) is not int
        or value["version"] != 1
        or not isinstance(value["balances"], dict)
        or len(value["balances"]) > MAX_HISTORY_ENTRIES
    ):
        raise ValueError("HISTORY_INVALID")
    for key, quota in value["balances"].items():
        if not isinstance(key, str) or HISTORY_KEY_PATTERN.fullmatch(key) is None or not _valid_quota(quota):
            raise ValueError("HISTORY_INVALID")
    return {"version": 1, "balances": dict(value["balances"])}


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("HISTORY_INVALID")
        value[key] = item
    return value


def load_history(path):
    try:
        with Path(path).open("rb") as stream:
            content = stream.read(MAX_HISTORY_BYTES + 1)
        if len(content) > MAX_HISTORY_BYTES:
            return _empty_history()
        return _validated_history(json.loads(content.decode("utf-8"), object_pairs_hook=_unique_object))
    except (OSError, ValueError, TypeError, RecursionError):
        return _empty_history()


def save_history(path, history):
    temporary = None
    try:
        payload = json.dumps(
            _validated_history(history), ensure_ascii=True, allow_nan=False, separators=(",", ":"),
        ).encode("utf-8")
        if len(payload) > MAX_HISTORY_BYTES:
            return False
        path = Path(path)
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, prefix=".history-", delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        return True
    except (OSError, ValueError, TypeError, RecursionError):
        return False
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _account_key(account):
    if not isinstance(account, dict):
        return None
    values = [account.get(field) for field in ("id", "site", "username")]
    if any(not isinstance(value, str) or not value for value in values):
        return None
    try:
        identity = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(identity).hexdigest()
    except UnicodeError:
        return None


def apply_history(rows, accounts_by_label, history):
    try:
        previous = _validated_history(history)["balances"]
    except (ValueError, TypeError):
        previous = {}
    if not isinstance(accounts_by_label, dict):
        accounts_by_label = {}
    keys = {label: _account_key(account) for label, account in accounts_by_label.items()}
    current_keys = {key for key in keys.values() if key is not None}
    balances = {key: quota for key, quota in previous.items() if key in current_keys}
    enriched = []
    for label, detail, stage in rows:
        detail = copy.deepcopy(detail) if isinstance(detail, dict) else {}
        key = keys.get(label)
        detail["previous_quota"] = previous.get(key) if key is not None else None
        quota = detail.get("quota")
        if stage != "SUCCESS" or not _valid_quota(quota):
            quota = None
        detail["quota"] = quota
        detail["exit_ip"] = _canonical_ip(detail.get("exit_ip"))
        if key is not None and quota is not None:
            balances[key] = quota
        enriched.append((label, detail, stage))
    # Configs cannot normally exceed this bound; never emit an oversized cache.
    balances = dict(sorted(balances.items())[:MAX_HISTORY_ENTRIES])
    return enriched, {"version": 1, "balances": balances}


def _canonical_ip(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or "%" in value:
        return None
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


def _proxy_url(proxy):
    if not isinstance(proxy, dict) or not isinstance(proxy.get("server"), str):
        return None
    server = proxy["server"]
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in server):
        return None
    try:
        parsed = urlsplit(server)
        if (
            parsed.scheme not in {"http", "https", "socks4", "socks4a", "socks5", "socks5h"}
            or not parsed.hostname
            or parsed.port is not None and not 1 <= parsed.port <= 65535
            or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment
        ):
            return None
        if "username" in proxy or "password" in proxy:
            username, password = proxy.get("username"), proxy.get("password")
            if (
                not isinstance(username, str) or not username
                or not isinstance(password, str) or parsed.username is not None
                or parsed.scheme in {"socks4", "socks4a"}
            ):
                return None
            auth = quote(username, safe="") + ":" + quote(password, safe="")
            return parsed.scheme + "://" + auth + "@" + parsed.netloc
        if parsed.username is not None:
            if not parsed.username or parsed.password is None or parsed.scheme in {"socks4", "socks4a"}:
                return None
        return server
    except (ValueError, UnicodeError):
        return None


def query_exit_ip(proxy):
    server = _proxy_url(proxy)
    if server is None:
        return None
    session = response = None
    try:
        import requests

        session = requests.Session()
        session.trust_env = False
        response = session.get(
            "https://api.ipify.org", proxies={"http": server, "https": server},
            timeout=5, allow_redirects=False, stream=True,
        )
        if response.status_code != 200:
            return None
        body = bytearray()
        for chunk in response.iter_content(chunk_size=MAX_IP_BYTES):
            if len(body) + len(chunk) > MAX_IP_BYTES:
                return None
            body.extend(chunk)
        return _canonical_ip(body.decode("ascii"))
    except Exception:
        return None
    finally:
        for resource in (response, session):
            if resource is not None:
                try:
                    resource.close()
                except Exception:
                    pass


def safe_user_group(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 64
            or value != value.strip() or not value.isprintable()):
        return None
    return value


def query_country(ip):
    address = _canonical_ip(ip)
    if address is None:
        return None
    parsed = ipaddress.ip_address(address)
    if not parsed.is_global or parsed.is_multicast or parsed.is_reserved:
        return None
    session = response = None
    try:
        import requests

        session = requests.Session()
        session.trust_env = False
        response = session.get(
            f"https://ipwho.is/{address}",
            params={"fields": "success,ip,country,country_code", "lang": "zh-CN"},
            timeout=5, allow_redirects=False, stream=True,
        )
        if response.status_code != 200:
            return None
        body = bytearray()
        for chunk in response.iter_content(chunk_size=1024):
            if len(body) + len(chunk) > MAX_COUNTRY_BYTES:
                return None
            body.extend(chunk)
        payload = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object)
        if (not isinstance(payload, dict) or payload.get("success") is not True
                or _canonical_ip(payload.get("ip")) != address):
            return None
        name, code = payload.get("country"), payload.get("country_code")
        if (not isinstance(name, str) or not 1 <= len(name) <= 80
                or name != name.strip() or not name.isprintable()
                or not isinstance(code, str) or re.fullmatch(r"[A-Z]{2}", code) is None):
            return None
        return {"name": name, "code": code}
    except Exception:
        return None
    finally:
        for resource in (response, session):
            if resource is not None:
                try:
                    resource.close()
                except Exception:
                    pass


def enrich_countries(rows):
    cache, enriched = {}, []
    for label, detail, stage in rows:
        detail = copy.deepcopy(detail) if isinstance(detail, dict) else {}
        ip = _canonical_ip(detail.get("exit_ip"))
        if ip and ip not in cache:
            try:
                cache[ip] = query_country(ip)
            except Exception:
                cache[ip] = None
        detail["country"] = cache.get(ip)
        enriched.append((label, detail, stage))
    return enriched
