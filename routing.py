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
    MANIFEST_WRITE_FAIL SUBSCRIPTION_TIMEOUT RANDOM_PLAN_INVALID RANDOM_PLAN_MISMATCH
    SNAPSHOT_MISSING SNAPSHOT_READ_FAIL SNAPSHOT_WRITE_FAIL SNAPSHOT_INVALID SNAPSHOT_TOO_LARGE
    SNAPSHOT_CONTEXT_INVALID SNAPSHOT_PLAN_MISMATCH""".split())
DIAGNOSTIC_FIELDS = set("""config version subscription_url notifications telegram wecom bot_token chat_id
    webhook_url groups ubuntu macos windows accounts id username password os site proxies link node random
    profile viewport screen width height device_scale_factor locale timezone_id color_scheme api access_token
    user_id manifest mode random_plan""".split())
DIAGNOSTIC_NUMBERS = ("status", "line", "column", "total", "valid", "rejected", "duplicate", "distinct",
                      "excluded", "available", "requested", "account_index", "proxy_index")
COUNTRY_LOCALES = {"SG": "en-SG", "KR": "ko-KR", "JP": "ja-JP", "DE": "de-DE", "US": "en-US", "HK": "zh-HK"}


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


def diagnostic_help(value):
    # Reuse the machine formatter's allowlist; never render raw fields or values.
    diagnostic = format_diagnostic(value)
    safe = dict(part.split("=", 1) for part in diagnostic.split()[1:])
    field, reason = safe["field"], safe["reason"]
    systems = {"ubuntu": "Ubuntu", "windows": "Windows", "macos": "macOS"}
    location = re.sub(r"^groups\.(ubuntu|windows|macos)\.accounts\[(\d+)\]",
                      lambda m: f"{systems[m[1]]} 组第 {int(m[2]) + 1} 个账号", field)
    location = re.sub(r"proxies\[(\d+)\]", lambda m: f"第 {int(m[1]) + 1} 个代理", location)
    choices = {
        "id": ("账号 id 格式不正确", "使用 1～32 个字符，英文字母开头，仅含字母、数字、_、-，例如 win01；所有账号 id 不重复"),
        "version": ("配置版本不支持", "使用 version: 2 配合 groups，或 version: 1 配合 accounts"),
        "locale": ("浏览器语言不支持", "使用 auto 自动跟随出口国家，或固定 zh-CN / en-US"),
        "os": ("系统名称不支持", "仅使用 ubuntu、windows、macos"),
        "device_scale_factor": ("缩放比例不支持", "使用整数 1 或 2"),
        "color_scheme": ("颜色模式不支持", "使用 light 或 dark"),
        "timezone_id": ("兼容时区值不支持", "省略 timezone_id，登录前按出口 IP 自动检测时区"),
    }
    messages = {
        "NONEMPTY_STRING": ("字段为空或不是字符串", "填写非空字符串；账号密码必须填写，且不要复制脱敏占位值"),
        "URL_INVALID": ("链接格式不符合字段要求", "站点/订阅/webhook 使用完整 HTTPS 地址；代理 link 使用受支持的节点链接"),
        "FIELDS_INVALID": ("字段缺失、多余或结构不正确", "对照配置手册检查字段名和层级；每个代理只填写 link、node、random 中的一种"),
        "JSON_INVALID": ("JSON 语法错误", "按诊断中的行号和列号检查引号、逗号、括号；不要加 Markdown 代码围栏"),
        "JSON_DUPLICATE_KEY": ("JSON 存在重复字段", "删除同一对象内的重复键，不要让后一个值覆盖前一个值"),
        "JSON_NONFINITE": ("JSON 含非标准数字", "删除 NaN / Infinity，改用有限数字"),
        "CONFIG_REQUIRED": ("没有有效的新模式配置", "在 Actions Secret CHECKIN_CONFIG 中保存完整 JSON"),
        "CONFIG_TOO_LARGE": ("配置超过 48 KiB", "减少配置内容，单个 CHECKIN_CONFIG 不超过 48 KiB"),
        "DUPLICATE_ID": ("账号 id 重复", "给每个账号设置唯一 id，不要随意修改已有历史账号的 id"),
        "DUPLICATE_LOGIN": ("同一站点的同一账号配置了多次", "每个真实账号只保留一项，不要同时放进多个系统组"),
        "DUPLICATE_PROXY": ("固定代理配置重复", "删除重复代理，或为账号选择不同的固定节点"),
        "OS_INHERITED_FROM_GROUP": ("账号重复设置了 os", "version: 2 的系统由外层组决定，删除账号内的 os"),
        "INTEGER_REQUIRED": ("字段必须是整数", "使用整数，不要使用小数、字符串或 true/false"),
        "INTEGER_RANGE": ("整数超出允许范围", "random 使用正整数；检查视口/屏幕尺寸和候选数量的配置范围"),
        "SCREEN_SMALLER_THAN_VIEWPORT": ("屏幕尺寸小于浏览器视口", "让 screen 的宽和高分别不小于 viewport"),
        "SUBSCRIPTION_REQUIRED": ("node/random 需要订阅，但未配置", "填写 subscription_url，或只使用固定 link"),
        "SUBSCRIPTION_HTTP_ERROR": ("订阅服务返回非成功 HTTP 状态", "按状态码检查订阅地址、授权、限流和服务可用性"),
        "SUBSCRIPTION_TIMEOUT": ("订阅请求或读取超时", "检查订阅服务是否可达；服务恢复后新建 main 工作流运行"),
        "SUBSCRIPTION_REQUEST_FAIL": ("无法建立订阅请求", "检查订阅地址、DNS、网络和服务可用性"),
        "SUBSCRIPTION_READ_FAIL": ("订阅响应读取失败", "检查订阅服务是否返回完整内容；不要上传原始订阅排障"),
        "SUBSCRIPTION_CLOSE_FAIL": ("订阅响应关闭失败", "检查运行依赖和响应读取过程，新建运行，不复用异常响应"),
        "SUBSCRIPTION_TOO_LARGE": ("订阅响应过大", "减少订阅节点或使用精简订阅导出"),
        "SUBSCRIPTION_FORMAT_INVALID": ("订阅格式不支持或内容损坏", "使用支持的链接列表、Base64 或 Clash/Sub-Store 导出格式"),
        "SUBSCRIPTION_NO_VALID_NODES": ("订阅没有可解析的有效节点", "检查导出格式和节点参数；查看 total / rejected 计数"),
        "SUBSCRIPTION_DUPLICATE_NODE_NAME": ("按 node 指定的订阅名称重复", "使用唯一节点名称，或改用 link / random"),
        "POOL_TOO_SMALL": ("排除固定节点后随机池容量不足", "减少 random 数量或增加不同的有效节点，不能重复借用其他账号的节点"),
        "POOL_INVALID": ("节点池结构未通过校验", "检查订阅导出格式和本轮快照，不修改内部节点池来绕过校验"),
        "POOL_PLAN_FAIL": ("随机计划生成失败", "检查有效节点和 random 数量；新建 main 运行，不替换随机计划"),
        "FIXED_LINK_INVALID": ("固定 link 节点无法解析", "重新导出客户端可用的完整节点链接，检查协议和参数"),
        "FIXED_NODE_MISSING": ("指定 node 在订阅中找不到", "核对节点名称；名称经常变化时改用 random"),
        "FIXED_NODE_DUPLICATE": ("多个固定配置指向同一节点", "选择不同的固定节点，保留账号代理隔离"),
        "RANDOM_PLAN_MISMATCH": ("随机计划与本轮配置或节点池不一致", "确认各阶段配置不变，更新代码后新建 main 运行，不重跑旧提交"),
        "RANDOM_PLAN_INVALID": ("随机计划缺失或格式不正确", "使用最新完整工作流并新建 main 运行，不手动编辑 RANDOM_PLAN"),
        "SNAPSHOT_MISSING": ("本轮加密节点池快照缺失或已过期", "新建 main 工作流；快照仅保留 1 天，不能重建旧随机计划"),
        "SNAPSHOT_CONTEXT_INVALID": ("缺少本轮 Actions 仓库/运行/提交上下文", "使用完整的最新工作流，不要单独复制 worker 环境运行"),
        "SNAPSHOT_PLAN_MISMATCH": ("快照与本轮随机计划不匹配", "保持本轮配置不变，新建 main 运行，不能替换或跳过快照校验"),
        "SNAPSHOT_INVALID": ("加密快照校验失败", "确认各阶段 CHECKIN_CONFIG 相同；不要修改快照，新建 main 运行"),
        "SNAPSHOT_READ_FAIL": ("快照文件无法读取", "检查 artifact 下载和文件权限，新建 main 运行"),
        "SNAPSHOT_WRITE_FAIL": ("快照文件保存失败", "检查 runner 临时目录权限和空间，不覆盖已有快照"),
        "SNAPSHOT_TOO_LARGE": ("快照超过安全大小限制", "减少订阅节点数量，不关闭大小校验"),
        "MANIFEST_WRITE_FAIL": ("路由清单写入失败", "检查 runner 临时目录权限和空间"),
    }
    cause, remedy = (choices.get(field.rsplit(".", 1)[-1], ("字段值不在允许范围", "对照配置手册填写受支持的值"))
                     if reason == "INVALID_CHOICE" else messages.get(reason,
                     ("配置或准备阶段未通过校验", "结合安全诊断码检查配置手册；新建 main 运行，不要绕过校验")))
    return f"配置位置：{location}。原因：{cause}。处理：{remedy}。【{diagnostic}】"


def failure_help(stage):
    messages = {
        "EXIT_IP_FAIL": ("当前代理未能返回有效出口 IP，尚未登录", "检查节点及出口查询服务；将按顺序尝试剩余自有节点，若已用尽请补充可用节点"),
        "TIMEZONE_LOOKUP_FAIL": ("出口 IP 的国家或有效时区查询失败，尚未登录", "检查定位服务可用性；跳过该节点，不用默认时区或直连兜底"),
        "FORM_NOT_FOUND": ("未找到可见的邮箱登录表单", "检查网站入口、WAF 验证和页面改版，不能据此断定密码错误"),
        "FORM_OPERATE_TIMEOUT": ("登录表单操作超时", "检查表单控件和网站响应；这不是已确认的密码错误"),
        "WAF_TIMEOUT": ("网站安全验证未在期限内完成", "更换可用节点，检查验证页；不能绕过网站校验"),
        "GOTO_TIMEOUT": ("打开登录页超时", "检查代理到站点的连通性及站点服务"),
        "PAGE_TIMEOUT": ("登录后的页面等待超时", "检查站点响应和代理稳定性"),
        "BROWSER_LAUNCH_FAIL": ("浏览器启动失败", "检查 Playwright Chromium 安装及 runner 系统依赖"),
        "USER_API_FAIL": ("无法取得登录态用户信息", "检查站点用户接口、登录状态和代理响应"),
        "API_PAYLOAD_FAIL": ("用户接口返回格式不符合要求", "检查站点是否改版，不要把原始用户响应上传排障"),
        "LOGIN_UNVERIFIED": ("没有取得足够证据证明登录成功", "核对登录态用户接口和表单适配，不把脚本结束当作成功"),
        "AUTH_IDENTITY_MISMATCH": ("登录身份与配置账号不一致", "核对账号和 API 配置，不能复用其他账号的登录态"),
        "QUOTA_INVALID": ("返回的余额格式不合法", "检查站点余额字段和单位，不能把无效余额计作成功"),
        "NODE_MISSING": ("指定节点不存在", "检查订阅名称或固定 link，使用有效的账号自有候选"),
        "NODE_CONFIG_FAIL": ("节点参数无法解析", "重新导出可用节点链接，检查协议、UUID 和传输参数"),
        "NODE_UNREACHABLE": ("节点连通性检查失败", "更换账号自有候选节点，检查服务器和端口"),
        "PROXY_LIST_EXHAUSTED": ("账号没有剩余可用候选", "检查每个候选的前序错误，补充有效节点，不回退直连"),
        "NO_PROXY": ("没有可用代理", "检查代理配置和候选节点"),
        "PROXY_START_FAIL": ("本地代理初始化失败", "查看同一步 BINARY_DOWNLOAD / NATIVE_CHECK / PORT_READY 诊断，检查下载、配置和端口"),
        "BINARY_DOWNLOAD_FAIL": ("Xray 下载或完整性校验失败，尚未尝试账号登录", "查看下载 HTTP 状态/重试/哈希诊断；服务恢复后新建运行，不关闭哈希校验"),
        "JOB_MISSING": ("执行组未上传结果报告", "查看该系统任务是否失败或被取消"),
        "REPORT_INVALID": ("结果报告缺失、损坏或不符合本轮账号分配", "检查 artifact 上传/下载和各任务日志，不伪造成功结果"),
        "PREPARE_FAIL": ("准备任务失败，登录组可能尚未执行", "打开 prepare 步骤的字段位置、原因和处理建议，修复后新建 main 运行"),
        "ROUTE_CONFIG_FAIL": ("配置或账号路由校验失败", "查看 PREPARE_DIAGNOSTIC 的字段位置和中文建议，核对各阶段配置相同"),
        "RANDOM_POOL_FAIL": ("随机节点池或加密快照校验失败", "查看 RANDOM_DIAGNOSTIC 的具体原因，保持配置不变并新建 main 运行"),
        "UNFINISHED": ("账号执行未完成", "检查任务取消、runner 异常或代理初始化阶段日志"),
        "UNEXPECTED": ("账号执行发生未分类异常", "查看安全阶段诊断，检查运行依赖和站点变化，不提交凭据或原始响应"),
        "UNKNOWN": ("没有取得可靠执行结果", "检查该任务的前序日志和结果报告"),
    }
    cause, remedy = messages.get(stage, ("执行未通过校验", "检查安全诊断和配置，不绕过失败检查"))
    return f"原因：{cause}。处理：{remedy}。"


def emit_help(message, *, error=False):
    actions = os.environ.get("GITHUB_ACTIONS") == "true"
    try:
        print(message, flush=True)
        if actions and error:
            escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(f"::error title=签到运行失败::{escaped}", flush=True)
    except (OSError, ValueError):
        pass
    if actions:
        path = os.environ.get("GITHUB_STEP_SUMMARY")
        if path:
            try:
                with open(path, "a", encoding="utf-8") as stream:
                    stream.write("\n- " + message.replace("\n", " ") + "\n")
            except (OSError, ValueError):
                pass


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
    if not isinstance(locale, str) or locale not in {"zh-CN", "en-US", "auto"}:
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
    if "random" in manifest:
        from random_snapshot import SNAPSHOT_NAME, write_snapshot

        write_snapshot(path.with_name(SNAPSHOT_NAME), config, manifest["random"], names, nodes)
        if os.environ.get("GITHUB_ENV"):
            try:
                with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
                    stream.write("RANDOM_SNAPSHOT_READY=true\n")
            except OSError:
                _fail("SNAPSHOT_WRITE_FAIL", "random_plan")
        print("PREPARE_SNAPSHOT_READY")
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
        from random_snapshot import SNAPSHOT_NAME

        values["RANDOM_PLAN"] = json.dumps(manifest["random"], separators=(",", ":"))
        values["RANDOM_SNAPSHOT_PATH"] = str(Path(manifest_path).resolve().with_name(SNAPSHOT_NAME))
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
        emit_help(diagnostic_help(getattr(error, "diagnostic", None)), error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
