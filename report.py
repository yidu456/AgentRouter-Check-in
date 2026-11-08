import argparse
import ipaddress
import json
import os
import re
import sys
from pathlib import Path


ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
RUNNER_NAMES = {"ubuntu-24.04", "windows-2022", "macos-15"}
GROUP_KEYS = {"group_id", "os", "account_ids", "mode"}
RESULT_KEYS = {"id", "quota", "stage"}
REPORT_KEYS = {"version", "group_id", "os", "results"}
FAILURE_STAGES = {
    "UNKNOWN",
    "GOTO_TIMEOUT",
    "WAF_TIMEOUT",
    "FORM_NOT_FOUND",
    "FORM_OPERATE_TIMEOUT",
    "USER_API_FAIL",
    "API_PAYLOAD_FAIL",
    "LOGIN_UNVERIFIED",
    "AUTH_IDENTITY_MISMATCH",
    "QUOTA_INVALID",
    "PAGE_TIMEOUT",
    "BROWSER_LAUNCH_FAIL",
    "UNEXPECTED",
    "NO_PROXY",
    "PROXY_LIST_EXHAUSTED",
    "UNFINISHED",
    "ROUTE_CONFIG_FAIL",
    "NODE_MISSING",
    "NODE_CONFIG_FAIL",
    "NODE_UNREACHABLE",
    "PROXY_START_FAIL",
    "JOB_MISSING",
    "REPORT_INVALID",
    "PREPARE_FAIL",
    "RANDOM_POOL_FAIL",
    "EXIT_IP_FAIL",
    "TIMEZONE_LOOKUP_FAIL",
}
STAGES = FAILURE_STAGES | {"SUCCESS"}


def _invalid():
    raise ValueError("REPORT_INVALID")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _invalid()
        value[key] = item
    return value


def _validate_group(value):
    if not isinstance(value, dict) or set(value) != GROUP_KEYS:
        _invalid()
    group_id = value["group_id"]
    account_ids = value["account_ids"]
    if not isinstance(group_id, str) or ID_PATTERN.fullmatch(group_id) is None:
        _invalid()
    if (
        not isinstance(value["os"], str)
        or value["os"] not in RUNNER_NAMES
        or not isinstance(value["mode"], str)
        or value["mode"] not in {"isolated", "legacy"}
    ):
        _invalid()
    if (
        not isinstance(account_ids, list)
        or not account_ids
        or value["mode"] == "isolated" and len(account_ids) > 3
    ):
        _invalid()
    if any(not isinstance(item, str) or ID_PATTERN.fullmatch(item) is None for item in account_ids):
        _invalid()
    if len(set(account_ids)) != len(account_ids):
        _invalid()


def _validate_manifest(value):
    if not isinstance(value, dict) or not {"version", "groups"} <= set(value) or set(value) - {"version", "groups", "random"}:
        _invalid()
    if type(value["version"]) is not int or value["version"] != 1:
        _invalid()
    groups = value["groups"]
    if not isinstance(groups, list) or not 1 <= len(groups) <= 256:
        _invalid()

    legacy_groups = [
        item
        for item in groups
        if isinstance(item, dict) and item.get("mode") == "legacy"
    ]
    if legacy_groups and (
        len(groups) != 1 or legacy_groups[0].get("os") != "ubuntu-24.04"
    ):
        _invalid()
    if "random" in value:
        if legacy_groups:
            _invalid()
        from subscription_pool import validate_plan

        try:
            validate_plan(value["random"])
        except Exception:
            _invalid()

    group_ids = set()
    account_ids = set()
    for item in groups:
        _validate_group(item)
        if item["group_id"] in group_ids or account_ids.intersection(item["account_ids"]):
            _invalid()
        group_ids.add(item["group_id"])
        account_ids.update(item["account_ids"])


def _validate_results(rows, expected_ids):
    if not isinstance(rows, list) or len(rows) != len(expected_ids):
        _invalid()

    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not RESULT_KEYS <= set(row) or set(row) - (RESULT_KEYS | {"exit_ip", "user_group", "country", "timezone_id"}):
            _invalid()
        account_id = row["id"]
        quota = row["quota"]
        stage = row["stage"]
        if (
            not isinstance(account_id, str)
            or account_id not in expected_ids
            or account_id in seen
            or not isinstance(stage, str)
            or stage not in STAGES
        ):
            _invalid()
        if stage == "SUCCESS":
            if quota is not None and (type(quota) is not int or not 0 <= quota <= 2**63 - 1):
                _invalid()
        elif quota is not None:
            _invalid()
        if row.get("user_group") is not None:
            from account_observations import safe_user_group

            if safe_user_group(row["user_group"]) is None:
                _invalid()
        from account_observations import safe_country, safe_timezone

        if row.get("country") is not None:
            if safe_country(row["country"]) != row["country"]:
                _invalid()
        if row.get("timezone_id") is not None and safe_timezone(row["timezone_id"]) is None:
            _invalid()
        exit_ip = row.get("exit_ip")
        if exit_ip is not None:
            if not isinstance(exit_ip, str) or len(exit_ip) > 45 or "%" in exit_ip:
                _invalid()
            try:
                if str(ipaddress.ip_address(exit_ip)) != exit_ip:
                    _invalid()
            except ValueError:
                _invalid()
        seen.add(account_id)

    if seen != set(expected_ids):
        _invalid()


def _safe_report(manifest_group, rows):
    _validate_group(manifest_group)
    _validate_results(rows, manifest_group["account_ids"])
    return {
        "version": 1,
        "group_id": manifest_group["group_id"],
        "os": manifest_group["os"],
        "results": [
            {key: row[key] for key in ("id", "quota", "stage", "exit_ip", "user_group", "country", "timezone_id") if key in row}
            for row in rows
        ],
    }


def write_report(path: Path, manifest_group: dict, rows: list[dict]) -> None:
    public_report = _safe_report(manifest_group, rows)
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(public_report, stream, ensure_ascii=True, allow_nan=False)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _read_group_report(path, manifest_group):
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream, object_pairs_hook=_unique_object)
    if not isinstance(value, dict) or set(value) != REPORT_KEYS:
        _invalid()
    if type(value["version"]) is not int or value["version"] != 1:
        _invalid()
    if value["group_id"] != manifest_group["group_id"] or value["os"] != manifest_group["os"]:
        _invalid()
    _validate_results(value["results"], manifest_group["account_ids"])
    return value["results"]


def combine_reports(manifest: dict, reports_dir: Path, details: bool = False) -> list:
    _validate_manifest(manifest)
    combined = []
    for manifest_group in manifest["groups"]:
        path = reports_dir / f"checkin-results-{manifest_group['group_id']}" / "result.json"
        try:
            if path.is_file():
                rows = _read_group_report(path, manifest_group)
            else:
                rows = [
                    {"id": account_id, "quota": None, "stage": "JOB_MISSING"}
                    for account_id in manifest_group["account_ids"]
                ]

            group_rows = []
            rows_by_id = {row["id"]: row for row in rows}
            for account_id in manifest_group["account_ids"]:
                row = rows_by_id[account_id]
                balance = None
                if row["stage"] == "SUCCESS" and row["quota"] is not None:
                    from app import format_balance

                    balance = format_balance(row["quota"])
                group_rows.append(
                    (f"{manifest_group['os']} {account_id}",
                     {"quota": row["quota"], "balance": balance, "exit_ip": row.get("exit_ip")} if details else balance,
                     row["stage"])
                )
                if details:
                    for key in ("user_group", "country", "timezone_id"):
                        if key in row:
                            group_rows[-1][1][key] = row[key]
        except Exception:
            group_rows = [
                (f"{manifest_group['os']} {account_id}",
                 {"quota": None, "balance": None, "exit_ip": None} if details else None, "REPORT_INVALID")
                for account_id in manifest_group["account_ids"]
            ]
        combined.extend(group_rows)
    return combined


def _load_manifest(path):
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream, object_pairs_hook=_unique_object)
    _validate_manifest(value)
    return value


def _new_notification_config():
    raw_present = "CHECKIN_CONFIG" in os.environ
    raw = os.environ.get("CHECKIN_CONFIG")
    mode = os.environ.get("CHECKIN_MODE", "")
    if mode not in {"", "isolated", "legacy"}:
        raise ValueError("ROUTE_CONFIG_FAIL")
    if mode == "legacy":
        if raw:
            raise ValueError("ROUTE_CONFIG_FAIL")
        return None, None
    if not raw_present and mode != "isolated":
        return None, None
    if not raw:
        raise ValueError("ROUTE_CONFIG_FAIL")

    from routing import parse_config

    parsed = parse_config(raw)
    return parsed["notifications"], parsed


def _send_rows(rows, notification_config):
    from app import format_notifications, send_notifications

    success_count = sum(stage == "SUCCESS" for _, _, stage in rows)
    html_message, plain_message = format_notifications(rows, success_count, len(rows))
    try:
        if notification_config is None:
            send_notifications(html_message, plain_message, config=None)
        else:
            send_notifications(html_message, plain_message, config=notification_config, wecom_markdown=True)
    except Exception:
        print("NOTIFY_FAIL", file=sys.stderr)


def observe_balances(rows: list, config: dict, history_path: Path | None = None) -> list:
    from account_observations import apply_history, enrich_countries, load_history, save_history
    from routing import RUNNERS

    accounts = {f"{RUNNERS[a['os']]} {a['id']}": a for a in config["accounts"]}
    history, status = (load_history(history_path, with_status=True) if history_path is not None
                       else ({"version": 1, "balances": {}}, "DISABLED"))
    enriched, updated = apply_history(rows, accounts, history)
    if history_path is not None:
        print(f"HISTORY_LOAD_{status}", flush=True)
        saved = False
        try:
            if status == "READ_FAILED":
                raise OSError("HISTORY_SAVE_FAIL")
            history_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not save_history(history_path, updated):
                raise OSError("HISTORY_SAVE_FAIL")
            output_path = os.environ.get("GITHUB_ENV")
            if output_path:
                with open(output_path, "a", encoding="utf-8") as stream:
                    stream.write("BALANCE_HISTORY_READY=true\n")
            saved = True
        except OSError:
            print("HISTORY_SAVE_FAIL", file=sys.stderr)
        for _, detail, _ in enriched:
            detail["history_status"] = ("AVAILABLE" if detail["previous_quota"] is not None
                                         else "NO_BASELINE" if status == "RESTORED" else status)
            detail["history_saved"] = saved
    return enrich_countries(enriched) if config["notifications"] else enriched


def _notify(manifest_path, reports_dir):
    prepare_succeeded = os.environ.get("PREPARE_RESULT") == "success"
    try:
        notification_config, config = _new_notification_config()
    except Exception:
        print("ROUTE_CONFIG_FAIL", file=sys.stderr)
        return 1

    if not prepare_succeeded:
        if config is not None and notification_config:
            try:
                _send_rows([("Prepare", None, "PREPARE_FAIL")], notification_config)
            except Exception:
                print("NOTIFY_FAIL", file=sys.stderr)
        else:
            print("PREPARE_FAIL", file=sys.stderr)
        return 1

    try:
        if config is not None:
            from routing import build_manifest

            # The validated configuration remains authoritative if artifacts are lost or altered.
            public_manifest = build_manifest(config["accounts"])
        else:
            public_manifest = _load_manifest(manifest_path)
        rows = combine_reports(public_manifest, reports_dir, details=config is not None)
        if config is not None:
            history_path = os.environ.get("BALANCE_HISTORY_PATH")
            rows = observe_balances(rows, config, Path(history_path) if history_path else None)
    except Exception:
        print("REPORT_INVALID", file=sys.stderr)
        rows = [("Manifest", None, "REPORT_INVALID")]

    outcome = 0 if all(stage == "SUCCESS" for _, _, stage in rows) else 1
    try:
        _send_rows(rows, notification_config)
    except Exception:
        print("NOTIFY_FAIL", file=sys.stderr)
    return outcome


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    notify_parser = subparsers.add_parser("notify")
    notify_parser.add_argument("--manifest", required=True, type=Path)
    notify_parser.add_argument("--reports-dir", required=True, type=Path)
    args = parser.parse_args(argv)

    if args.command == "notify":
        return _notify(args.manifest, args.reports_dir)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
