import copy
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import uuid


MAX_POOL_BYTES = 4 * 1024 * 1024
_SEED = re.compile(r"[0-9a-f]{32}")
_FINGERPRINT = re.compile(r"[0-9a-f]{64}")


def _fail():
    raise ValueError("RANDOM_POOL_FAIL")


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def has_random(accounts):
    return any("random" in candidate for account in accounts for candidate in account["proxies"])


def validate_plan(plan):
    if (not isinstance(plan, dict) or set(plan) != {"seed", "fingerprint"}
            or not isinstance(plan["seed"], str) or not _SEED.fullmatch(plan["seed"])
            or not isinstance(plan["fingerprint"], str) or not _FINGERPRINT.fullmatch(plan["fingerprint"])):
        _fail()


def _host(value):
    try:
        return ipaddress.ip_address(value).compressed
    except ValueError:
        return value.encode("idna").decode("ascii").lower().rstrip(".")


def _shape(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        _fail()


def _neutral(node):
    from proxy_runtime import _ws_path, build_proxy_config

    if not isinstance(node, dict):
        _fail()
    result = copy.deepcopy(node)
    result.pop("tag", None)
    kind = result.get("type")
    fields = {
        "socks": ({"version"}, {"username", "password"}),
        "vless": ({"uuid"}, {"flow", "tls", "transport"}),
        "vmess": ({"uuid", "security"}, {"tls", "transport"}),
        "trojan": ({"password", "tls"}, {"transport"}),
        "hysteria2": ({"password", "tls"}, {"obfs"}),
    }
    if kind not in fields:
        _fail()
    required, optional = fields[kind]
    _shape(result, {"type", "server", "server_port"} | required, optional)
    if type(result["server_port"]) is not int:
        _fail()
    if "tls" in result:
        tls = result["tls"]
        _shape(tls, {"enabled", "server_name", "insecure"}, {"utls", "reality"})
        if tls["enabled"] is not True or type(tls["insecure"]) is not bool:
            _fail()
        if "utls" in tls:
            _shape(tls["utls"], {"enabled", "fingerprint"})
            if tls["utls"]["enabled"] is not True:
                _fail()
        if "reality" in tls:
            _shape(tls["reality"], {"enabled", "public_key", "short_id"})
            if tls["reality"]["enabled"] is not True:
                _fail()
    if "transport" in result:
        transport = result["transport"]
        if not isinstance(transport, dict):
            _fail()
        if transport.get("type") == "ws":
            _shape(transport, {"type"}, {"path", "headers", "max_early_data", "early_data_header_name"})
            if "headers" in transport:
                _shape(transport["headers"], {"Host"})
        elif transport.get("type") == "grpc":
            _shape(transport, {"type", "service_name"})
        else:
            _fail()
    if "obfs" in result:
        _shape(result["obfs"], {"type", "password"})
    build_proxy_config({"candidate": result})
    result["server"] = _host(result["server"])
    if "uuid" in result:
        result["uuid"] = str(uuid.UUID(result["uuid"]))
    if "tls" in result:
        result["tls"]["server_name"] = _host(result["tls"]["server_name"])
    if result.get("transport", {}).get("type") == "ws":
        transport = result["transport"]
        # The adapter emits early data in the effective path, not separate fields.
        transport["path"] = _ws_path(transport)
        transport.pop("max_early_data", None)
        transport.pop("early_data_header_name", None)
    return result


def load_pool(url, require_names=False):
    response = None
    try:
        from routing import _https_url

        _https_url(url)
        if type(require_names) is not bool:
            _fail()
        import requests
        from proxy_runtime import _link_lines, _node_name, parse_node_link

        response = requests.get(url, stream=True, timeout=30)
        response.raise_for_status()
        chunks, size = [], 0
        for chunk in response.iter_content(64 * 1024):
            if not chunk:
                continue
            size += len(chunk)
            if size > MAX_POOL_BYTES:
                _fail()
            chunks.append(chunk)
        named, seen_names, duplicate_names, pool = {}, set(), set(), {}
        for link in _link_lines(b"".join(chunks)):
            try:
                name = _node_name(link)
            except ValueError:
                name = ""
            if name:
                if name in seen_names:
                    if require_names:
                        _fail()
                    duplicate_names.add(name)
                    named.pop(name, None)
                seen_names.add(name)
            try:
                node = _neutral(parse_node_link(link, "subscription"))
            except ValueError:
                continue
            pool[_canonical(node)] = node
            if name and name not in duplicate_names:
                named[name] = link
        if not pool:
            _fail()
        return named, [pool[identity] for identity in sorted(pool)]
    except Exception:
        _fail()
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                _fail()


def _context(config, named_links, nodes):
    from routing import _normalize_config
    from proxy_runtime import parse_node_link

    source = copy.deepcopy(config)
    if not isinstance(source, dict):
        _fail()
    # Normalized routing configs include an empty optional subscription URL.
    if source.get("subscription_url") == "":
        source.pop("subscription_url")
    validated = _normalize_config(source)
    if not isinstance(nodes, list) or not isinstance(named_links, dict):
        _fail()
    pool = {}
    for node in nodes:
        neutral = _neutral(node)
        pool[_canonical(neutral)] = neutral
    named_identities = {}
    for name, link in named_links.items():
        if not isinstance(name, str) or not name or name != name.strip():
            _fail()
        identity = _canonical(_neutral(parse_node_link(link, "subscription")))
        if identity not in pool:
            _fail()
        named_identities[name] = identity
    reserved, fixed_routes, requested = set(), {}, 0
    for account in validated["accounts"]:
        for position, candidate in enumerate(account["proxies"]):
            if "random" in candidate:
                requested += candidate["random"]
                continue
            if "node" in candidate:
                name = candidate["node"]
                identity = named_identities[name]
                link = named_links[name]
            else:
                link = candidate["link"]
                identity = _canonical(_neutral(parse_node_link(link, "fixed")))
            if identity in reserved:
                _fail()
            reserved.add(identity)
            fixed_routes[(account["id"], position)] = (link, identity)
    eligible = set(pool) - reserved
    if requested > len(eligible):
        _fail()
    canonical_config = copy.deepcopy(validated)
    canonical_config["accounts"].sort(key=lambda account: account["id"])
    return validated["accounts"], _canonical(canonical_config), pool, reserved, eligible, fixed_routes


def _fingerprint(seed, key, pool, reserved, fixed_routes):
    message = {"seed": seed, "pool": [identity.decode("utf-8") for identity in sorted(pool)],
               "reserved": [identity.decode("utf-8") for identity in sorted(reserved)],
               "fixed": [[account_id, position, identity.decode("utf-8")]
                         for (account_id, position), (_, identity) in sorted(fixed_routes.items())]}
    return hmac.new(key, _canonical(message), hashlib.sha256).hexdigest()


def make_plan(config, named_links, nodes, seed=None):
    try:
        if seed is None:
            seed = secrets.token_hex(16)
        validate_plan({"seed": seed, "fingerprint": "0" * 64})
        _, key, pool, reserved, _, fixed_routes = _context(config, named_links, nodes)
        return {"seed": seed, "fingerprint": _fingerprint(seed, key, pool, reserved, fixed_routes)}
    except Exception:
        _fail()


def resolve_random_accounts(config, plan, named_links, nodes):
    try:
        validate_plan(plan)
        accounts, key, pool, reserved, eligible, fixed_routes = _context(config, named_links, nodes)
        expected = _fingerprint(plan["seed"], key, pool, reserved, fixed_routes)
        if not hmac.compare_digest(expected, plan["fingerprint"]):
            _fail()
        seed = bytes.fromhex(plan["seed"])
        ranked = sorted(eligible, key=lambda identity: (hmac.new(seed, identity, hashlib.sha256).digest(), identity))
        offset = 0
        for account in sorted(accounts, key=lambda account: account["id"]):
            candidates = []
            for position, candidate in enumerate(account["proxies"]):
                if "random" in candidate:
                    count = candidate["random"]
                    candidates.extend({"outbound": copy.deepcopy(pool[identity])}
                                      for identity in ranked[offset:offset + count])
                    offset += count
                else:
                    link, _ = fixed_routes[(account["id"], position)]
                    candidates.append({"link": link})
            account["proxies"] = candidates
        return accounts
    except Exception:
        _fail()
