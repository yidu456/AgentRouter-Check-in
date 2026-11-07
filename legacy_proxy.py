"""Linux Actions legacy proxy setup using the shared, pinned Xray runtime."""

import os
import shutil
import platform
import tempfile
import time
from pathlib import Path

import requests

from proxy_runtime import _link_lines, _stop_child, download_binary, parse_node_link, start_proxy


def node_links():
    source = os.environ.get("NODE_LINK") or os.environ.get("PROXY_CONFIG_URL") or ""
    if not source:
        return []
    if source.startswith(("https://", "http://")):
        response = requests.get(source, timeout=30)
        response.raise_for_status()
        return _link_lines(response.content)
    return _link_lines(source.encode("utf-8"))


def probe(endpoint, timeout):
    try:
        with requests.Session() as session:
            session.trust_env = False
            response = session.get("https://api.ipify.org", timeout=timeout,
                                   proxies={"http": endpoint, "https": endpoint})
            response.raise_for_status()
        return True
    except requests.RequestException:
        return False


def main():
    directory = None
    child = None
    selected = False
    try:
        links = node_links()
        if not links:
            print("LEGACY_PROXY_NOT_CONFIGURED")
            return 0
        env_path = os.environ.get("GITHUB_ENV")
        if not env_path:
            raise ValueError("LEGACY_ENV_MISSING")
        directory = Path(tempfile.mkdtemp(prefix="checkin-legacy-proxy-",
                                         dir=os.environ.get("RUNNER_TEMP") or None))
        binary = download_binary(platform.system(), platform.machine(), directory)
        for link in links:
            try:
                outbound = parse_node_link(link, "legacy")
                child, endpoints = start_proxy({"legacy": outbound}, binary, directory)
                endpoint = endpoints["legacy"]
                if not probe(endpoint, 10):
                    continue
                for attempt in range(3):
                    if probe(endpoint, 15):
                        with Path(env_path).open("a", encoding="utf-8", newline="\n") as stream:
                            stream.write(f"PROXY_SERVER={endpoint}\n")
                        selected = True
                        print("LEGACY_PROXY_READY")
                        return 0
                    if attempt < 2:
                        time.sleep(3)
            except (ValueError, RuntimeError):
                print("LEGACY_NODE_FAIL")
            finally:
                if not selected and child is not None:
                    _stop_child(child)
                    child = None
        print("LEGACY_PROXY_EXHAUSTED")
        return 1
    except Exception:
        print("LEGACY_PROXY_SETUP_FAIL")
        return 1
    finally:
        if not selected:
            if child is not None:
                _stop_child(child)
            if directory is not None:
                shutil.rmtree(directory, ignore_errors=True)
        # The selected child and its private files live until Actions cleans the runner.


if __name__ == "__main__":
    raise SystemExit(main())
