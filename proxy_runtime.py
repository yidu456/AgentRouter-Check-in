import base64
import hashlib
import io
import ipaddress
import json
import os
import platform
import re
import socket
import stat
import subprocess
import tarfile
import time
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, unquote, urlsplit

import requests


VERSION = "1.14.4"
DOWNLOAD_PREFIX = f"https://github.com/SagerNet/sing-box/releases/download/v{VERSION}/"
MAX_ARCHIVE_SIZE = 100 * 1024 * 1024
START_TIMEOUT = 15
CHECK_TIMEOUT = 15
SHUTDOWN_TIMEOUT = 5
FIRST_PORT = 18080
MAX_ENDPOINTS = 65535 - FIRST_PORT + 1

ASSETS = {
    ("Linux", "amd64"): (
        "sing-box-1.14.4-linux-amd64.tar.gz",
        "699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968",
    ),
    ("Linux", "arm64"): (
        "sing-box-1.14.4-linux-arm64.tar.gz",
        "436441f76ee2f7fe21b5b2d426d3cb261a480455a704865789ad533e4273ec26",
    ),
    ("Darwin", "amd64"): (
        "sing-box-1.14.4-darwin-amd64.tar.gz",
        "eae86b9b033bba50b7c44ab719e4bfac0aca05efd28483390ed3aa510f32db25",
    ),
    ("Darwin", "arm64"): (
        "sing-box-1.14.4-darwin-arm64.tar.gz",
        "0d8c7f5ed5d587b0f1a5e9772a708ec3bfa4ac4c9329604b01d8d9c2ba406838",
    ),
    ("Windows", "amd64"): (
        "sing-box-1.14.4-windows-amd64.zip",
        "99185d75d314a07dbba4a130c8ad986cbeb629a07927975636b341ca61f991df",
    ),
}

_LINK_SCHEMES = ("vless://", "vmess://", "trojan://", "hysteria2://", "hy2://", "socks5://", "socks://")
_TAG_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_SHORT_ID_RE = re.compile(r"^(?:[0-9a-fA-F]{2}){1,8}$")


def _node_fail():
    raise ValueError("NODE_CONFIG_FAIL")


def _binary_fail():
    raise ValueError("BINARY_DOWNLOAD_FAIL")


def _proxy_fail():
    raise RuntimeError("PROXY_START_FAIL")


def _decode_base64(value):
    if not isinstance(value, (str, bytes)):
        _node_fail()
    raw = value.encode("ascii") if isinstance(value, str) else value
    try:
        return base64.urlsafe_b64decode(raw + b"=" * (-len(raw) % 4))
    except (ValueError, UnicodeError):
        _node_fail()


def _link_lines(raw):
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        _node_fail()
    if text.lstrip().startswith(("{", "[")) or re.search(r"(?m)^\s*(proxies|proxy-groups)\s*:", text):
        _node_fail()
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if lines and any(re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", line) for line in lines):
        return lines
    try:
        decoded = _decode_base64("".join(text.split())).decode("utf-8-sig")
    except (UnicodeDecodeError, ValueError):
        _node_fail()
    if decoded.lstrip().startswith(("{", "[")) or re.search(r"(?m)^\s*(proxies|proxy-groups)\s*:", decoded):
        _node_fail()
    lines = [line.strip() for line in decoded.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if not lines or not any(re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", line) for line in lines):
        _node_fail()
    return lines


def _vmess_payload(link):
    encoded = link[len("vmess://"):]
    if not encoded or "#" in encoded:
        _node_fail()
    try:
        payload = json.loads(_decode_base64(encoded).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _node_fail()
    if not isinstance(payload, dict):
        _node_fail()
    return payload


def _node_name(link):
    if link.lower().startswith("vmess://"):
        name = _vmess_payload(link).get("ps")
        return name.strip() if isinstance(name, str) else ""
    try:
        name = _decode_component(link.partition("#")[2])
    except ValueError:
        _node_fail()
    return name.strip()


def load_node_links(subscription_url):
    try:
        parsed = urlsplit(subscription_url)
        if parsed.scheme != "https" or not parsed.hostname:
            _node_fail()
        response = requests.get(subscription_url, timeout=30)
        response.raise_for_status()
        lines = _link_lines(response.content)
        nodes = {}
        names = set()
        for link in lines:
            try:
                name = _node_name(link)
            except ValueError:
                continue
            if not name:
                continue
            if name in names:
                _node_fail()
            names.add(name)
            if not link.lower().startswith(_LINK_SCHEMES):
                continue
            try:
                parse_node_link(link, "subscription")
            except ValueError:
                continue
            nodes[name] = link
        if not nodes:
            _node_fail()
        return nodes
    except ValueError as error:
        if str(error) == "NODE_CONFIG_FAIL":
            raise
        _node_fail()
    except Exception:
        _node_fail()


def _query(parsed):
    if re.search(r"%(?![0-9a-fA-F]{2})", parsed.query):
        _node_fail()
    try:
        parsed_query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=False, errors="strict")
    except ValueError:
        _node_fail()
    if any(len(values) != 1 for values in parsed_query.values()):
        _node_fail()
    return {key: values[0] for key, values in parsed_query.items()}


def _decode_component(value):
    if re.search(r"%(?![0-9a-fA-F]{2})", value):
        _node_fail()
    try:
        return unquote(value, errors="strict")
    except UnicodeDecodeError:
        _node_fail()


def _required_text(value):
    if not isinstance(value, str) or not value or any(character in value for character in "\r\n\0"):
        _node_fail()
    return value


def _server(value):
    value = _required_text(value)
    if value != value.strip() or any(character.isspace() for character in value):
        _node_fail()
    try:
        ipaddress.ip_address(value)
        return value
    except ValueError:
        pass
    try:
        ascii_value = value.encode("idna").decode("ascii")
    except UnicodeError:
        _node_fail()
    labels = ascii_value.rstrip(".").split(".")
    if len(ascii_value) > 253 or any(
        not label or len(label) > 63 or label.startswith("-") or label.endswith("-")
        or not all(character.isalnum() or character == "-" for character in label)
        for label in labels
    ):
        _node_fail()
    return value


def _port(value):
    if type(value) is int:
        number = value
    elif isinstance(value, str) and value.isascii() and value.isdigit():
        number = int(value)
    else:
        _node_fail()
    if not 1 <= number <= 65535:
        _node_fail()
    return number


def _uuid(value):
    value = _required_text(value)
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError):
        _node_fail()
    return value


def _bool(value, default=False):
    if value is None:
        return default
    if value is True or type(value) is int and value == 1 or value in ("true", "1"):
        return True
    if value is False or type(value) is int and value == 0 or value in ("false", "0"):
        return False
    _node_fail()


def _common_url(link):
    try:
        parsed = urlsplit(link)
        server = parsed.hostname
        port = parsed.port
    except ValueError:
        _node_fail()
    return parsed, _server(server), _port(port), _query(parsed)


def _only_query(query, allowed):
    if set(query) - set(allowed):
        _node_fail()


def _transport(kind, path="", host="", service_name=""):
    if kind in (None, ""):
        kind = "tcp"
    elif not isinstance(kind, str):
        _node_fail()
    if not all(isinstance(value, str) for value in (path, host, service_name)):
        _node_fail()
    kind = kind.lower()
    if kind in ("tcp", "none"):
        if path or host or service_name:
            _node_fail()
        return None
    if kind == "ws":
        if service_name:
            _node_fail()
        transport = {"type": "ws"}
        if path:
            transport["path"] = path
        if host:
            transport["headers"] = {"Host": host}
        return transport
    if kind in ("grpc", "gun"):
        if path or host:
            _node_fail()
        return {"type": "grpc", "service_name": _required_text(service_name)}
    _node_fail()


def _tls(server, query, required=False, reality=False):
    security = query.get("security", "")
    has_tls_parameters = any(key in query for key in ("sni", "serverName", "insecure", "allowInsecure", "pbk", "publicKey", "sid", "shortId"))
    reality_parameters = any(key in query for key in ("pbk", "publicKey", "sid", "shortId", "fp"))
    if not reality and reality_parameters:
        _node_fail()
    if reality:
        enabled = True
    elif required:
        if security not in ("", "tls"):
            _node_fail()
        enabled = True
    elif security in ("tls",):
        enabled = True
    elif security in ("", "none"):
        if has_tls_parameters:
            _node_fail()
        return None
    else:
        _node_fail()
    insecure_value = query.get("insecure", query.get("allowInsecure"))
    tls = {
        "enabled": enabled,
        "server_name": _server(query.get("sni") or query.get("serverName") or server),
        "insecure": _bool(insecure_value),
    }
    if reality:
        fingerprint = query.get("fp") or "chrome"
        if fingerprint not in {
            "chrome", "firefox", "edge", "safari", "360", "qq", "ios", "android", "random", "randomized",
        }:
            _node_fail()
        tls["utls"] = {"enabled": True, "fingerprint": fingerprint}
        public_key = query.get("pbk") or query.get("publicKey")
        short_id = query.get("sid") or query.get("shortId")
        if not isinstance(short_id, str) or not _SHORT_ID_RE.fullmatch(short_id):
            _node_fail()
        tls["reality"] = {
            "enabled": True,
            "public_key": _required_text(public_key),
            "short_id": short_id,
        }
    return tls


def _parse_vless(link, tag):
    parsed, server, port, query = _common_url(link)
    _only_query(query, {
        "encryption", "flow", "security", "sni", "serverName", "insecure", "allowInsecure",
        "pbk", "publicKey", "sid", "shortId", "fp", "type", "path", "host", "serviceName", "service_name",
    })
    if parsed.password is not None:
        _node_fail()
    outbound = {
        "type": "vless", "server": server, "server_port": port,
        "uuid": _uuid(_decode_component(parsed.username or "")), "tag": tag,
    }
    encryption = query.get("encryption", "none")
    if encryption != "none":
        _node_fail()
    flow = query.get("flow")
    if flow:
        if flow != "xtls-rprx-vision" or query.get("security") not in ("tls", "reality"):
            _node_fail()
        outbound["flow"] = flow
    security = query.get("security", "")
    tls = _tls(server, query, reality=security == "reality")
    if tls:
        outbound["tls"] = tls
    transport = _transport(
        query.get("type"), query.get("path", ""), query.get("host", ""),
        query.get("serviceName") or query.get("service_name", ""),
    )
    if transport:
        outbound["transport"] = transport
    return outbound


def _parse_vmess(link, tag):
    payload = _vmess_payload(link)
    allowed = {
        "v", "ps", "add", "port", "id", "aid", "net", "tls", "sni", "serverName",
        "allowInsecure", "host", "path", "serviceName", "service_name", "scy", "type",
    }
    if set(payload) - allowed or payload.get("scy", "auto") not in ("", "auto") or payload.get("type", "none") not in ("", "none"):
        _node_fail()
    server = _server(payload.get("add"))
    outbound = {
        "type": "vmess", "server": server, "server_port": _port(payload.get("port")),
        "uuid": _uuid(payload.get("id")), "security": "auto", "tag": tag,
    }
    aid = payload.get("aid", 0)
    if isinstance(aid, bool):
        _node_fail()
    try:
        if int(aid) != 0:
            _node_fail()
    except (TypeError, ValueError):
        _node_fail()
    tls_mode = payload.get("tls", "")
    if tls_mode not in ("", "none", "tls"):
        _node_fail()
    if tls_mode == "tls":
        tls_query = {
            "security": "tls",
            "sni": payload.get("sni") or payload.get("serverName") or server,
        }
        if "allowInsecure" in payload:
            tls_query["allowInsecure"] = payload["allowInsecure"]
        outbound["tls"] = _tls(server, tls_query)
    elif any(key in payload for key in ("sni", "serverName", "allowInsecure")):
        _node_fail()
    transport = _transport(
        payload.get("net"), payload.get("path", ""), payload.get("host", ""),
        payload.get("serviceName") or payload.get("service_name", ""),
    )
    if transport:
        outbound["transport"] = transport
    return outbound


def _parse_trojan(link, tag):
    parsed, server, port, query = _common_url(link)
    _only_query(query, {
        "security", "sni", "serverName", "insecure", "allowInsecure",
        "type", "path", "host", "serviceName", "service_name",
    })
    if parsed.password is not None:
        _node_fail()
    outbound = {
        "type": "trojan", "server": server, "server_port": port,
        "password": _required_text(_decode_component(parsed.username or "")), "tag": tag,
        "tls": _tls(server, query, required=True),
    }
    transport = _transport(
        query.get("type"), query.get("path", ""), query.get("host", ""),
        query.get("serviceName") or query.get("service_name", ""),
    )
    if transport:
        outbound["transport"] = transport
    return outbound


def _parse_hysteria2(link, tag):
    parsed, server, port, query = _common_url(link)
    _only_query(query, {
        "security", "sni", "serverName", "insecure", "allowInsecure",
        "obfs", "obfs-password", "obfs_password",
    })
    if parsed.password is not None:
        _node_fail()
    outbound = {
        "type": "hysteria2", "server": server, "server_port": port,
        "password": _required_text(_decode_component(parsed.username or "")), "tag": tag,
        "tls": _tls(server, query, required=True),
    }
    obfs = query.get("obfs")
    if obfs:
        if obfs != "salamander":
            _node_fail()
        obfs_password = query.get("obfs-password") or query.get("obfs_password")
        outbound["obfs"] = {"type": "salamander", "password": _required_text(obfs_password)}
    elif "obfs-password" in query or "obfs_password" in query:
        _node_fail()
    return outbound


def _parse_socks(link, tag):
    parsed, server, port, query = _common_url(link)
    if query:
        _node_fail()
    outbound = {
        "type": "socks", "server": server, "server_port": port, "version": "5", "tag": tag,
    }
    if parsed.username is not None:
        username = _decode_component(parsed.username)
        password = _decode_component(parsed.password or "")
        if not username or parsed.password is None:
            _node_fail()
        outbound.update(username=username, **{"password": password})
    elif parsed.password is not None:
        _node_fail()
    return outbound


def parse_node_link(link, tag):
    try:
        if not isinstance(link, str) or not isinstance(tag, str) or not _TAG_RE.fullmatch(tag):
            _node_fail()
        scheme = urlsplit(link).scheme.lower()
        parsers = {
            "vless": _parse_vless,
            "vmess": _parse_vmess,
            "trojan": _parse_trojan,
            "hysteria2": _parse_hysteria2,
            "hy2": _parse_hysteria2,
            "socks5": _parse_socks,
            "socks": _parse_socks,
        }
        if scheme not in parsers:
            _node_fail()
        return parsers[scheme](link, tag)
    except ValueError as error:
        if str(error) == "NODE_CONFIG_FAIL":
            raise
        _node_fail()
    except Exception:
        _node_fail()


def _normalize_machine(machine):
    normalized = str(machine).lower()
    if normalized in ("x86_64", "amd64"):
        return "amd64"
    if normalized in ("aarch64", "arm64"):
        return "arm64"
    _binary_fail()


def _archive_bytes(url):
    response = requests.get(url, stream=True, timeout=30)
    response.raise_for_status()
    chunks = []
    total = 0
    for chunk in response.iter_content(64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_ARCHIVE_SIZE:
            _binary_fail()
        chunks.append(chunk)
    return b"".join(chunks)


def _expected_member(asset):
    if asset.endswith(".tar.gz"):
        root = asset[:-7]
        return f"{root}/sing-box", "sing-box"
    if asset.endswith(".zip"):
        root = asset[:-4]
        return f"{root}/sing-box.exe", "sing-box.exe"
    _binary_fail()


def _read_executable(asset, archive_data):
    member_name, destination_name = _expected_member(asset)
    if PurePosixPath(member_name).parts[:1] != (asset.rsplit(".", 2)[0] if asset.endswith(".tar.gz") else asset[:-4],):
        _binary_fail()
    if asset.endswith(".tar.gz"):
        with tarfile.open(fileobj=io.BytesIO(archive_data), mode="r:gz") as archive:
            try:
                member = archive.getmember(member_name)
            except KeyError:
                _binary_fail()
            if not member.isreg():
                _binary_fail()
            stream = archive.extractfile(member)
            if stream is None:
                _binary_fail()
            data = stream.read(MAX_ARCHIVE_SIZE + 1)
    else:
        with zipfile.ZipFile(io.BytesIO(archive_data), mode="r") as archive:
            try:
                member = archive.getinfo(member_name)
            except KeyError:
                _binary_fail()
            mode = member.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if member.is_dir() or file_type not in (0, stat.S_IFREG):
                _binary_fail()
            with archive.open(member, "r") as stream:
                data = stream.read(MAX_ARCHIVE_SIZE + 1)
    if not data or len(data) > MAX_ARCHIVE_SIZE:
        _binary_fail()
    return destination_name, data


def download_binary(system, machine, directory):
    try:
        key = (system, _normalize_machine(machine))
        if key not in ASSETS:
            _binary_fail()
        asset, expected_digest = ASSETS[key]
        archive_data = _archive_bytes(DOWNLOAD_PREFIX + asset)
        if hashlib.sha256(archive_data).hexdigest() != expected_digest:
            _binary_fail()
        destination_name, executable = _read_executable(asset, archive_data)
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            directory.chmod(0o700)
        destination = directory / destination_name
        with destination.open("xb") as stream:
            stream.write(executable)
        if os.name != "nt":
            destination.chmod(0o700)
        return destination
    except ValueError as error:
        if str(error) == "BINARY_DOWNLOAD_FAIL":
            raise
        _binary_fail()
    except Exception:
        _binary_fail()


def build_proxy_config(outbounds):
    try:
        if not isinstance(outbounds, dict) or not 1 <= len(outbounds) <= MAX_ENDPOINTS:
            raise ValueError
        config = {"log": {"disabled": True}, "inbounds": [], "outbounds": [], "route": {"rules": []}}
        endpoints = {}
        for offset, candidate_tag in enumerate(sorted(outbounds)):
            outbound = outbounds[candidate_tag]
            if not isinstance(candidate_tag, str) or not _TAG_RE.fullmatch(candidate_tag):
                raise ValueError
            if not isinstance(outbound, dict) or outbound.get("type") not in {
                "vless", "vmess", "trojan", "hysteria2", "socks",
            }:
                raise ValueError
            port = FIRST_PORT + offset
            inbound_tag = f"in-{candidate_tag}"
            outbound_tag = f"out-{candidate_tag}"
            config["inbounds"].append({
                "type": "http", "tag": inbound_tag, "listen": "127.0.0.1", "listen_port": port,
            })
            config["outbounds"].append(dict(outbound, tag=outbound_tag))
            config["route"]["rules"].append({
                "inbound": [inbound_tag], "action": "route", "outbound": outbound_tag,
            })
            endpoints[candidate_tag] = f"http://127.0.0.1:{port}"
        return config, endpoints
    except (TypeError, ValueError):
        raise ValueError("PROXY_START_FAIL")


def _write_config(config, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        path.parent.chmod(0o700)
    with path.open("w", encoding="utf-8") as stream:
        json.dump(config, stream, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    if os.name != "nt":
        path.chmod(0o600)


def _creationflags():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if platform.system() == "Windows" else 0


def _check_config(binary, config_path):
    try:
        result = subprocess.run(
            [str(binary), "check", "-c", str(config_path)], shell=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=CHECK_TIMEOUT,
            creationflags=_creationflags(),
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def check_outbound(outbound, binary, directory):
    try:
        config, _ = build_proxy_config({"candidate": outbound})
        path = Path(directory) / "candidate-check.json"
        _write_config(config, path)
        return _check_config(binary, path)
    except (OSError, TypeError, ValueError):
        return False
    finally:
        try:
            path.unlink(missing_ok=True)
        except (OSError, UnboundLocalError):
            pass


def _ports_ready(endpoints):
    for endpoint in endpoints.values():
        parsed = urlsplit(endpoint)
        try:
            with socket.create_connection((parsed.hostname, parsed.port), timeout=0.2):
                pass
        except OSError:
            return False
    return True


def _ports_available(endpoints):
    reservations = []
    try:
        for endpoint in endpoints.values():
            parsed = urlsplit(endpoint)
            reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            reservations.append(reservation)
            reservation.bind((parsed.hostname, parsed.port))
        return True
    except OSError:
        return False
    finally:
        for reservation in reservations:
            reservation.close()


def _stop_child(child):
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=SHUTDOWN_TIMEOUT)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=SHUTDOWN_TIMEOUT)


@contextmanager
def group_proxy(outbounds, binary, directory):
    child = None
    try:
        if not isinstance(outbounds, dict) or not 1 <= len(outbounds) <= MAX_ENDPOINTS:
            _proxy_fail()
        valid = {}
        directory = Path(directory)
        for candidate_tag, outbound in outbounds.items():
            candidate_path = None
            try:
                candidate_config, _ = build_proxy_config({candidate_tag: outbound})
                candidate_path = directory / f"check-{candidate_tag}.json"
                _write_config(candidate_config, candidate_path)
                if _check_config(binary, candidate_path):
                    valid[candidate_tag] = outbound
            except (OSError, TypeError, ValueError):
                continue
            finally:
                if candidate_path is not None:
                    try:
                        candidate_path.unlink(missing_ok=True)
                    except OSError:
                        pass
        if not valid:
            _proxy_fail()
        try:
            config, endpoints = build_proxy_config(valid)
            config_path = directory / "proxy-config.json"
            _write_config(config, config_path)
        except (OSError, TypeError, ValueError):
            _proxy_fail()
        if not _check_config(binary, config_path):
            _proxy_fail()
        if not _ports_available(endpoints):
            _proxy_fail()
        try:
            child = subprocess.Popen(
                [str(binary), "run", "-c", str(config_path)], shell=False,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=_creationflags(),
            )
        except OSError:
            _proxy_fail()
        deadline = time.monotonic() + START_TIMEOUT
        while True:
            if child.poll() is not None:
                _proxy_fail()
            if _ports_ready(endpoints):
                if child.poll() is not None:
                    _proxy_fail()
                break
            if time.monotonic() >= deadline:
                _proxy_fail()
            time.sleep(0.05)
        yield endpoints
    finally:
        _stop_child(child)
