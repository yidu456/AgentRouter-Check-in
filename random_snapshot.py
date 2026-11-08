import copy
import hashlib
import hmac
import json
import os
from pathlib import Path

from subscription_pool import _canonical, _fail, resolve_random_accounts, validate_plan


SNAPSHOT_NAME = "random-pool.bin"
MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024


def _key(config):
    from routing import _normalize_config

    source = copy.deepcopy(config)
    if source.get("subscription_url") == "":
        source.pop("subscription_url")
    validated = _normalize_config(source)
    validated["accounts"].sort(key=lambda account: account["id"])
    context = {name: os.environ.get(name, "")
               for name in ("GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_SHA")}
    if os.environ.get("GITHUB_ACTIONS") == "true" and not all(context.values()):
        _fail("SNAPSHOT_CONTEXT_INVALID", "random_plan")
    # Bind to the run, not its attempt: failed-job reruns reuse preparation.
    return hmac.new(_canonical(validated), b"checkin-random-snapshot-v1\0" + _canonical(context),
                    hashlib.sha256).digest()


def write_snapshot(path, config, plan, named_links, nodes):
    try:
        from nacl.secret import SecretBox

        validate_plan(plan)
        resolve_random_accounts(config, plan, named_links, nodes)
        payload = _canonical({"version": 1, "plan": plan, "named_links": named_links, "nodes": nodes})
        if len(payload) + SecretBox.NONCE_SIZE + SecretBox.MACBYTES > MAX_SNAPSHOT_BYTES:
            _fail("SNAPSHOT_TOO_LARGE", "random_plan")
        data = SecretBox(_key(config)).encrypt(payload)
    except ValueError as error:
        if str(error) == "RANDOM_POOL_FAIL":
            raise
        _fail("SNAPSHOT_INVALID", "random_plan")
    except Exception:
        _fail("SNAPSHOT_INVALID", "random_plan")
    try:
        with Path(path).open("xb") as stream:
            if os.name != "nt":
                os.chmod(path, 0o600)
            stream.write(data)
    except Exception:
        _fail("SNAPSHOT_WRITE_FAIL", "random_plan")


def load_snapshot(path, config, plan):
    validate_plan(plan)
    try:
        with Path(path).open("rb") as stream:
            data = stream.read(MAX_SNAPSHOT_BYTES + 1)
    except FileNotFoundError:
        _fail("SNAPSHOT_MISSING", "random_plan")
    except Exception:
        _fail("SNAPSHOT_READ_FAIL", "random_plan")
    if len(data) > MAX_SNAPSHOT_BYTES:
        _fail("SNAPSHOT_TOO_LARGE", "random_plan")
    try:
        from nacl.secret import SecretBox
        from report import _unique_object

        payload = json.loads(SecretBox(_key(config)).decrypt(data).decode("utf-8"),
                             object_pairs_hook=_unique_object)
        if (not isinstance(payload, dict) or set(payload) != {"version", "plan", "named_links", "nodes"}
                or type(payload["version"]) is not int or payload["version"] != 1):
            _fail("SNAPSHOT_INVALID", "random_plan")
        validate_plan(payload["plan"])
        if payload["plan"] != plan:
            _fail("SNAPSHOT_PLAN_MISMATCH", "random_plan")
    except ValueError as error:
        if str(error) == "RANDOM_POOL_FAIL":
            raise
        _fail("SNAPSHOT_INVALID", "random_plan")
    except Exception:
        _fail("SNAPSHOT_INVALID", "random_plan")
    return resolve_random_accounts(config, plan, payload["named_links"], payload["nodes"])
