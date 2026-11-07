#!/usr/bin/env python3

import os
import sys
import time
import random
import re
import socket
import concurrent.futures
import html
import json
import platform
import tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests
from playwright.sync_api import sync_playwright, Error as PlaywrightError, TimeoutError as PlaywrightTimeoutError


# ============================================================
# 环境变量配置
# ============================================================

USERNAME = os.getenv("USERNAME") or ""
PASSWORD = os.getenv("PASSWORD") or ""

# 多账号配置（可选）
# 多行文本，每行一个账号，格式：邮箱:密码
ACCOUNTS = os.getenv("ACCOUNTS") or ""

TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN") or ""
TG_CHAT_ID = os.getenv("TG_CHAT_ID") or ""


# ============================================================
# 代理配置（可选）
# ============================================================

PROXY_SERVER = os.getenv("PROXY_SERVER") or ""
PROXY_USERNAME = os.getenv("PROXY_USERNAME") or ""
PROXY_PASSWORD = os.getenv("PROXY_PASSWORD") or ""


# ============================================================
# 基础配置
# ============================================================

# 默认站点（ACCOUNTS 行中未写站点前缀时使用）
DEFAULT_SITE_URL = "https://agentrouter.org"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# 登录表单元素候选选择器
# （new-api 系站点兼容）
LOGIN_FORM_INPUT_SELECTOR = (
    'input#username, input[name="username"], '
    'input[name="email"], input[type="password"]'
)

USERNAME_SELECTORS = (
    "input#username",
    'input[name="username"]',
    'input[name="email"]',
    'form input[type="text"]',
)

PASSWORD_SELECTORS = (
    "input#password",
    'input[name="password"]',
    'input[type="password"]',
)

SUBMIT_SELECTORS = (
    'button[type="submit"]',
    'button:text-is("登录")',
    'button:text-is("登 录")',
    'button:text-is("Log In")',
    'button:text-is("Sign In")',
)

# 邮箱登录入口的候选文案
EMAIL_LOGIN_TEXTS = (
    "Sign in with Email or Username",
    "Email or Username",
    "Sign in with Email",
    "使用 邮箱或用户名 登录",
    "账号登录",
    "邮箱登录",
    "密码登录",
)
EMAIL_LOGIN_PATTERN = re.compile(
    "|".join(re.escape(text).replace(r"\ ", r"\s*") for text in EMAIL_LOGIN_TEXTS),
    re.IGNORECASE,
)


# ============================================================
# 代理池配置
# ============================================================

FREEPROXY_POOL_URL = (
    "https://charlespikachu.github.io/freeproxy/proxies.json"
)

PROXY_COUNTRY = os.getenv("PROXY_COUNTRY") or ""

PROXY_SAMPLE_SIZE = int(
    os.getenv("PROXY_SAMPLE_SIZE") or "100"
)

PROXY_MAX_ROUNDS = int(
    os.getenv("PROXY_MAX_ROUNDS") or "5"
)

PROBE_TIMEOUT = 15

PROBE_WORKERS = 50

MAX_LOGIN_ATTEMPTS = 3

# 每个账号代理池登录轮数上限
# （一轮登录全部失败后，
#   重新随机提取代理再试，最多这么多轮）
PROXY_LOGIN_ROUNDS = int(
    os.getenv("PROXY_LOGIN_ROUNDS") or "5"
)


# ============================================================
# 浏览器请求头
# ============================================================

BROWSER_HEADERS = {
    "accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "sec-ch-ua": (
        '"Not=A?Brand";v="99", '
        '"Microsoft Edge";v="151", '
        '"Chromium";v="151"'
    ),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "upgrade-insecure-requests": "1",
    "user-agent": USER_AGENT,
}


# ============================================================
# 代理池请求头
# ============================================================

POOL_HEADERS = {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "referer": "https://charlespikachu.github.io/freeproxy/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": USER_AGENT,
}


# ============================================================
# WAF / 人机验证特征
# ============================================================

WAF_MARKERS = (
    # 指纹级特征
    "aliyun_waf_aa",
    "aliyun_waf_bb",
    "initaliyuncaptcha",
    "aliyuncaptcha-sliding-slider",
    "cf_app_waf",
    "captcha-frontend",

    # Cookie / WAF 标识
    "acw_sc__v2",
    "__acw",
    "acw_tc",
    "cdn_sec_tc",
    "x5secdata",
    "punishpage",

    # 中文验证
    "访问验证",
    "滑动验证",
    "安全验证",
    "人机验证",
    "滑动滑块",
    "拖动滑块",
    "完成以下验证",
    "请完成验证",
    "验证成功后",
    "异常访问拦截",
    "请求被拦截",

    # 通用验证
    "verify you are human",
    "verifying you are human",
    "attention required",
    "just a moment",
    "challenge-platform",
    "turnstile",
    "cf-challenge",
    "unusual traffic",
    "captcha",
)


# ============================================================
# 日志
# ============================================================

def log(message: str):
    """
    极简日志。

    注意：
    不允许传入用户名、User ID、密码、代理 IP、
    URL、HTML、接口响应、异常详情等敏感信息。
    """
    print(message, flush=True)


# ============================================================
# Telegram
# ============================================================

def send_telegram(message: str, token: str | None = None, chat_id: str | None = None) -> bool:
    """
    发送 Telegram 消息。

    消息内容只允许包含：
    - 当前余额
    - 签到状态

    不发送账号、用户名、User ID 等用户信息。
    """

    token = TG_BOT_TOKEN if token is None else token
    chat_id = TG_CHAT_ID if chat_id is None else chat_id
    if not token or not chat_id or not message:
        return False

    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"

        for index, chunk in enumerate(split_utf8_text(message, limit=3500)):
            if index:
                time.sleep(1.1)
            data = {"chat_id": chat_id, "text": chunk, "parse_mode": "HTML"}
            if '<a href="' in chunk:
                data["link_preview_options"] = {"is_disabled": True}
            response = requests.post(
                url,
                json=data,
                timeout=30,
                allow_redirects=False,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or payload.get("ok") is not True:
                return False
        return True

    except Exception:
        # 故意不打印异常，避免异常中包含敏感信息
        return False


def split_utf8_text(message: str, limit: int = 2048) -> list[str]:
    if limit < 4:
        raise ValueError("INVALID_TEXT_LIMIT")
    chunks, current, size = [], "", 0
    for line in message.splitlines(keepends=True):
        line_size = len(line.encode("utf-8"))
        if line_size <= limit:
            if current and size + line_size > limit:
                chunks.append(current)
                current, size = "", 0
            current += line
            size += line_size
            continue
        if current:
            chunks.append(current)
            current, size = "", 0
        for char in line:
            char_size = len(char.encode("utf-8"))
            if size + char_size > limit:
                chunks.append(current)
                current, size = "", 0
            current += char
            size += char_size
    if current:
        chunks.append(current)
    return chunks


def send_wecom(message: str, webhook_url: str = "", markdown: bool = False) -> bool:
    from routing import validate_webhook_url

    if not message or not validate_webhook_url(webhook_url):
        return False
    mode = "markdown" if markdown else "text"
    try:
        for index, chunk in enumerate(split_utf8_text(message)):
            if index:
                time.sleep(3.1)
            response = requests.post(
                webhook_url,
                json={"msgtype": mode, mode: {"content": chunk}},
                timeout=30,
                allow_redirects=False,
            )
            if not 200 <= response.status_code < 300:
                return False
            payload = response.json()
            if not isinstance(payload, dict) or type(payload.get("errcode")) is not int:
                return False
            if payload["errcode"] != 0:
                return False
        return True
    except Exception:
        return False


def send_notifications(telegram_message: str, plain_message: str,
                       config: dict | None = None, wecom_markdown: bool = False) -> dict:
    settings = ({"telegram": {"bot_token": TG_BOT_TOKEN, "chat_id": TG_CHAT_ID}}
                if config is None else config)
    outcomes = {"telegram": None, "wecom": None}
    telegram, wecom = settings.get("telegram", {}), settings.get("wecom", {})
    if telegram.get("bot_token") and telegram.get("chat_id"):
        try:
            outcomes["telegram"] = send_telegram(
                telegram_message, token=telegram["bot_token"], chat_id=telegram["chat_id"]
            )
        except Exception:
            outcomes["telegram"] = False
    if wecom.get("webhook_url"):
        try:
            outcomes["wecom"] = (send_wecom(plain_message, wecom["webhook_url"], markdown=True)
                                 if wecom_markdown else send_wecom(plain_message, wecom["webhook_url"]))
        except Exception:
            outcomes["wecom"] = False
    for channel, outcome in outcomes.items():
        if outcome is not None:
            log(f"通知 {channel}: {'SUCCESS' if outcome else 'FAILED'}")
    return outcomes


def _escape_wecom_markdown(value: str) -> str:
    return "".join("\\" + char if char in "\\`*_{}[]()#+!<>|" else char for char in value)


def format_notifications(results: list, success_count: int, total: int) -> tuple[str, str]:
    message_lines = ["🎁 <b>自动签到通知</b>", ""]
    plain_lines = ["🎁 自动签到通知", ""]
    for label, balance, stage in results:
        if isinstance(balance, dict):
            quota, previous = balance.get("quota"), balance.get("previous_quota")
            status = "登录成功" if stage == "SUCCESS" else f"登录失败（{stage}）"
            prefix = "✅ " if stage == "SUCCESS" else "❌ "
            before = format_balance(previous) if previous is not None else "未知"
            current = format_balance(quota) if quota is not None else "未获取"
            delta = "未知"
            if quota is not None and previous is not None:
                delta = f"{(quota - previous) / 500000:+.2f}$"
            suffix = (f": {status}\n  上次余额：{before}\n  余额变化：{delta}"
                      f"\n  当前余额：{current}")
            history_status = balance.get("history_status")
            if history_status in {"MISSING", "INVALID", "READ_FAILED", "NO_BASELINE"}:
                suffix += f"\n  历史基线：HISTORY_{history_status}"
            if balance.get("history_saved") is False:
                suffix += "\n  历史保存：HISTORY_SAVE_FAIL"
            group = balance.get("user_group") or "未获取"
            country = balance.get("country")
            country_label = f"{country['name']}（{country['code']}）" if country else "未获取"
            html_suffix = suffix + f"\n  用户分组：{group}\n  出口国家：{country_label}"
            markdown_suffix = suffix + (f"\n  用户分组：{_escape_wecom_markdown(group)}"
                                        f"\n  出口国家：{_escape_wecom_markdown(country_label)}")
            from account_observations import _canonical_ip

            ip = _canonical_ip(balance.get("exit_ip"))
            html_ip = markdown_ip = "未获取"
            if ip:
                url = f"https://ippure.com/?ip={quote(ip, safe='')}"
                html_ip = f'<a href="{html.escape(url, quote=True)}">{ip}</a>'
                markdown_ip = f"[{ip}]({url})"
            message_lines.append(prefix + html.escape(label) + html.escape(html_suffix)
                                 + f"\n  代理出口 IP：{html_ip}")
            plain_lines.append(prefix + _escape_wecom_markdown(label) + markdown_suffix
                               + f"\n  代理出口 IP：{markdown_ip}")
            continue
        elif balance is None:
            suffix = ": 登录成功；当前余额：未获取" if stage == "SUCCESS" else f": 签到失败（{stage}）"
            prefix = "✅ " if stage == "SUCCESS" else "❌ "
        else:
            suffix = f": 余额 {balance}"
            prefix = "✅ "
        message_lines.append(prefix + html.escape(label) + html.escape(suffix))
        plain_lines.append(prefix + label + suffix)
    footer = f"📊 成功 {success_count}/{total}"
    message_lines.extend(["", footer])
    plain_lines.extend(["", footer])
    return "\n".join(message_lines), "\n".join(plain_lines)


# ============================================================
# 账号解析
# ============================================================

def parse_accounts() -> list:
    """
    解析账号列表。

    优先级：
    1. ACCOUNTS（多行，每行 [站点URL|]邮箱:密码）
    2. USERNAME / PASSWORD（旧版单账号兼容）

    说明：
    - 站点前缀可省略，省略时使用默认站点
    - 站点与账号用 | 分隔
    - 密码中可以包含冒号，
      只按第一个冒号分割邮箱与密码
    """

    accounts = []

    invalid_lines = []

    if ACCOUNTS:

        for line_no, raw_line in enumerate(
            ACCOUNTS.splitlines(),
            start=1,
        ):

            # 清理 BOM / 零宽字符 / 全角竖线
            line = (
                raw_line.replace("\ufeff", "")
                .replace("\u200b", "")
                .replace("\uff5c", "|")
                .strip()
            )

            if not line:
                continue

            site_url = ""

            body = line

            # 站点前缀
            if "|" in line:

                site_url, _, body = line.partition("|")

                site_url = site_url.strip()

            # 全角冒号兜底
            # （仅当行内没有半角冒号时才转换）
            if ":" not in body and "：" in body:
                body = body.replace("：", ":")

            if ":" not in body:
                invalid_lines.append(line_no)
                continue

            username, _, password = body.partition(":")

            username = username.strip()

            password = password.strip()

            if not username or not password:
                invalid_lines.append(line_no)
                continue

            # 站点归一化
            if not site_url:
                site_url = DEFAULT_SITE_URL

            elif not site_url.startswith("http"):
                site_url = f"https://{site_url}"

            site_url = site_url.rstrip("/")

            accounts.append(
                {
                    "site": site_url,
                    "username": username,
                    "password": password,
                }
            )

        if invalid_lines:

            log(
                "配置警告：ACCOUNTS 第 "
                + ", ".join(
                    str(n) for n in invalid_lines
                )
                + " 行格式无效，已跳过"
            )

    # 兼容旧单账号配置
    if not accounts and USERNAME and PASSWORD:

        accounts.append(
            {
                "site": DEFAULT_SITE_URL,
                "username": USERNAME,
                "password": PASSWORD,
            }
        )

    return accounts


# ============================================================
# 站点打码
# ============================================================

def mask_site(
    site_url: str,
) -> str:

    """
    站点域名打码。

    只保留域名前几位，其余屏蔽。
    例：https://agentrouter.org -> agen***
    """

    domain = site_url or ""

    for prefix in ("https://", "http://"):

        if domain.startswith(prefix):

            domain = domain[len(prefix):]

            break

    domain = domain.split("/", 1)[0]

    visible = domain[:4]

    return f"{visible}***"


def mask_proxy(
    proxy_item: dict,
) -> str:

    """
    代理 IP 打码。

    只保留前两段，其余屏蔽。
    例：124.248.13.5:1080 -> 124.248.***.***:1080
    """

    ip = str(proxy_item.get("ip") or "")

    port = proxy_item.get("port") or ""

    parts = ip.split(".")

    if (
        len(parts) == 4
        and all(
            part.isdigit()
            for part in parts
        )
    ):

        return (
            f"{parts[0]}.{parts[1]}"
            f".***.***:{port}"
        )

    # 非 IPv4（域名 / IPv6）：
    # 只保留前 4 位
    visible = ip[:4]

    return f"{visible}***:{port}"


# ============================================================
# 获取代理池
# ============================================================

def fetch_proxy_pool() -> list:
    """
    从 freeproxy 获取代理池。
    """

    response = requests.get(
        FREEPROXY_POOL_URL,
        headers=POOL_HEADERS,
        timeout=30,
    )

    response.raise_for_status()

    payload = response.json()

    if isinstance(payload, dict):
        items = payload.get("data") or []

    elif isinstance(payload, list):
        items = payload

    else:
        items = []

    if not items:
        raise Exception("代理池为空")

    return items


# ============================================================
# 构造代理地址
# ============================================================

def build_proxy_candidates(
    ip,
    port,
    protocol=""
) -> list:

    protocol = str(protocol or "").lower()

    base = f"{ip}:{int(port)}"

    tokens = {
        token.strip()
        for token in protocol.replace("/", ",").split(",")
        if token.strip()
    }

    if "http" in tokens:
        return [
            (
                "http",
                f"http://{base}"
            )
        ]

    if "https" in tokens:
        return [
            (
                "https",
                f"https://{base}"
            ),
            (
                "http",
                f"http://{base}"
            ),
        ]

    if "socks5" in tokens:
        return [
            (
                "socks5",
                f"socks5://{base}"
            )
        ]

    if "socks4" in tokens:
        return [
            (
                "socks4",
                f"socks4://{base}"
            )
        ]

    return [
        (
            "http",
            f"http://{base}"
        )
    ]


# ============================================================
# TCP 预检
# ============================================================

def _tcp_reachable(
    ip,
    port,
    timeout: float = 5
) -> bool:

    try:
        with socket.create_connection(
            (
                str(ip),
                int(port)
            ),
            timeout=timeout,
        ):
            return True

    except OSError:
        return False


# ============================================================
# WAF 判断
# ============================================================

def looks_like_waf(
    status_code: int,
    html: str
) -> bool:

    if status_code in (403, 405, 429):
        return True

    body = (html or "").lower()

    return any(
        marker.lower() in body
        for marker in WAF_MARKERS
    )


# ============================================================
# 探测代理
# ============================================================

def probe_proxy(
    proxy_item: dict,
    site_url: str,
):

    ip = proxy_item.get("ip")
    port = proxy_item.get("port")

    try:
        candidates = build_proxy_candidates(
            ip,
            port,
            proxy_item.get("protocol"),
        )

    except (TypeError, ValueError):
        return None, "BAD_FORMAT"

    # TCP 预检
    if not _tcp_reachable(ip, port):
        return None, "PORT_UNREACHABLE"

    for scheme, server in candidates:

        try:

            response = requests.get(
                f"{site_url}/login",
                headers=BROWSER_HEADERS,
                proxies={
                    "http": server,
                    "https": server,
                },
                timeout=PROBE_TIMEOUT,
                allow_redirects=True,
            )

            # WAF
            if looks_like_waf(
                response.status_code,
                response.text[:20000],
            ):
                return None, "WAF"

            # 非 200
            if response.status_code != 200:
                return None, f"HTTP_{response.status_code}"

            return {
                "ip": ip,
                "port": int(port),
                "protocol": proxy_item.get(
                    "protocol",
                    ""
                ),
                "scheme": scheme,
                "anonymity": proxy_item.get(
                    "anonymity",
                    ""
                ),
                "speed": proxy_item.get(
                    "speed",
                    0
                ),
                "server": server,
            }, None

        except requests.exceptions.ProxyError:

            # 协议不匹配，继续尝试下一个 scheme
            continue

        except Exception:

            # 不返回异常文本
            return None, "ERROR"

    return None, "PROXY_ERROR"


# ============================================================
# 批量探测
# ============================================================

def _probe_batch(
    batch: list,
    site_url: str,
) -> tuple:

    clean = []

    stats = {}

    if not batch:
        return clean, stats

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(
            PROBE_WORKERS,
            len(batch),
        )
    ) as executor:

        future_map = {
            executor.submit(
                probe_proxy,
                item,
                site_url,
            ): item
            for item in batch
        }

        for future in concurrent.futures.as_completed(
            future_map
        ):

            try:
                result, reason = future.result()

            except Exception:
                result = None
                reason = "ERROR"

            if result is not None:

                clean.append(result)

            else:

                stats[reason] = (
                    stats.get(reason, 0) + 1
                )

    return clean, stats


# ============================================================
# 查找干净代理
# ============================================================

def find_clean_proxies(
    site_url: str,
    sample_size: int = PROXY_SAMPLE_SIZE,
    max_rounds: int = PROXY_MAX_ROUNDS,
    needed_count: int = 0,
) -> list:

    pool = fetch_proxy_pool()

    log(f"代理池获取: {len(pool)} 个代理")

    # 国家过滤
    if PROXY_COUNTRY:

        pool = [
            item
            for item in pool
            if str(
                item.get("country", "")
            ).upper()
            == PROXY_COUNTRY
        ]

        log(
            f"国家过滤后: {len(pool)} 个代理"
        )

        if not pool:
            raise Exception("代理池过滤后为空")

    # 打乱代理
    random.shuffle(pool)

    remaining = pool

    needed = needed_count or max(
        1,
        MAX_LOGIN_ATTEMPTS,
    )

    clean_proxies = []

    stats = {}

    scanned = 0

    for round_no in range(
        1,
        max_rounds + 1,
    ):

        batch = remaining[:sample_size]

        remaining = remaining[sample_size:]

        if not batch:
            break

        round_clean, round_stats = _probe_batch(
            batch,
            site_url,
        )

        clean_proxies.extend(
            round_clean
        )

        scanned += len(batch)

        for key, value in round_stats.items():

            stats[key] = (
                stats.get(key, 0)
                + value
            )

        if len(clean_proxies) >= needed:
            break

    # 按代理池速度排序
    clean_proxies.sort(
        key=lambda item: (
            item.get("speed") or 99999
        )
    )

    # 只输出数量与阶段码，不含敏感信息
    reason_text = ", ".join(
        f"{key} {value}"
        for key, value in sorted(
            stats.items(),
            key=lambda kv: -kv[1],
        )[:3]
    )

    log(
        f"代理池探测: 扫描 {scanned} 个，"
        f"可用 {len(clean_proxies)} 个"
        + (f"（{reason_text}）" if reason_text else "")
    )

    return clean_proxies


# ============================================================
# 共享代理队列（按站点独立）
# ============================================================

CLEAN_PROXIES_BY_SITE = {}

POOL_BROKEN_SITES = set()

# 直连兜底已失败的站点
# （ Runner IP 被 WAF 拦截时，
#   后续账号不再重复直连，避免无效耗时 ）
DIRECT_FAILED_SITES = set()


def pop_proxy(
    site_url: str,
    total_accounts: int,
) -> dict | None:

    """
    从该站点的共享代理队列取一个干净代理。

    每个代理在交给浏览器登录前都会现场复检，
    复检失败立即丢弃并尝试下一个；
    队列耗尽时针对该站点重新探测少量代理，
    探测失败则本次运行不再尝试该站点的代理池。
    """

    if site_url in POOL_BROKEN_SITES:
        return None

    queue = CLEAN_PROXIES_BY_SITE.get(
        site_url
    ) or []

    # ------------------------------------------------
    # 现场复检：剔除探测后已失效的代理
    # （免费代理存活期短，预探测的代理
    #   到真正登录时可能已经死了）
    # ------------------------------------------------

    while queue:

        candidate = queue.pop(0)

        fresh, _ = probe_proxy(
            candidate,
            site_url,
        )

        if fresh is not None:
            CLEAN_PROXIES_BY_SITE[site_url] = queue
            return fresh

    # ------------------------------------------------
    # 队列耗尽：重新探测少量代理
    #
    # 不再按账号数批量预留：
    # 预留越多，到使用时失效越多，
    # 且首次探测耗时随账号数爆炸
    # ------------------------------------------------

    log("代理队列耗尽，重新探测代理池")

    try:

        queue = find_clean_proxies(
            site_url=site_url,
            needed_count=MAX_LOGIN_ATTEMPTS,
        )

    except Exception:

        # 不打印异常详情
        queue = []

    CLEAN_PROXIES_BY_SITE[site_url] = queue

    if not queue:

        POOL_BROKEN_SITES.add(site_url)

        log("代理池不可用，本次运行跳过代理池通道")

        return None

    # ------------------------------------------------
    # 复检刚探测到的代理，
    # 全部当场失效则返回 None
    # ------------------------------------------------

    while queue:

        candidate = queue.pop(0)

        fresh, _ = probe_proxy(
            candidate,
            site_url,
        )

        if fresh is not None:
            CLEAN_PROXIES_BY_SITE[site_url] = queue
            return fresh

    return None


# ============================================================
# 等待 WAF
# ============================================================

def wait_for_waf_ready(
    page,
    context=None,
    timeout_ms: int = 45000,
) -> bool:

    WAF_COOKIE_NAMES = (
        "acw_tc",
        "cdn_sec_tc",
        "acw_sc__v2",
        "__jsluid_s",
        "__cf_bm",
    )

    deadline = (
        time.time()
        + timeout_ms / 1000.0
    )

    reload_count = 0

    last_reload_time = 0.0

    while time.time() < deadline:

        try:

            state = page.evaluate(
                """
                (emailPattern) => {
                    const bodyText =
                        (document.body &&
                         document.body.innerText) || '';

                    const visible = el =>
                        getComputedStyle(el).visibility === 'visible' &&
                        (el.offsetParent !== null || el.getClientRects().length > 0);
                    const hasLoginForm =
                        Array.from(document.querySelectorAll(
                            'input#username, input[name="username"], input[name="email"], input[type="password"]'
                        )).some(visible);

                    const hasLoginButton =
                        Array.from(document.querySelectorAll(
                            'button, [role="tab"], a, span, div'
                        )).some(el => visible(el) &&
                            new RegExp(emailPattern, 'i').test((el.innerText || '').trim()));

                    const challengeSelectors = [
                        '#challenge-form',
                        '.cf-challenge',
                        '#cf-challenge-running',
                        'iframe[src*="challenges.cloudflare.com"]',
                        '[class*="turnstile"]',
                        '[class*="captcha"]'
                    ];

                    const isChallenge =
                        challengeSelectors.some(
                            sel => !!document.querySelector(sel)
                        )
                        ||
                        /challenge|verify you are human|attention required|verification/i
                        .test(bodyText.slice(0, 300))
                        ||
                        document.title
                            .toLowerCase()
                            .includes('verification');

                    return {
                        hasLoginForm,
                        hasLoginButton,
                        isChallenge
                    };
                }
                """,
                EMAIL_LOGIN_PATTERN.pattern,
            )

        except Exception:

            page.wait_for_timeout(1000)

            continue

        # 登录页面已经出现
        if (
            state.get("hasLoginForm")
            or state.get("hasLoginButton")
        ):
            return True

        # WAF 挑战
        if state.get("isChallenge"):

            # Cookie 已生成时刷新
            if (
                context is not None
                and reload_count < 3
                and (
                    time.time()
                    - last_reload_time
                    >= 10
                )
            ):

                try:

                    cookie_names = {
                        cookie.get("name")
                        for cookie in context.cookies()
                    }

                    if any(
                        name in cookie_names
                        for name in WAF_COOKIE_NAMES
                    ):

                        page.reload(
                            wait_until="domcontentloaded",
                            timeout=30000,
                        )

                        reload_count += 1

                        last_reload_time = time.time()

                except Exception:
                    pass

        page.wait_for_timeout(1000)

    return False


# ============================================================
# 点击邮箱 / 用户名登录
# ============================================================

def click_email_login_button(
    page,
    timeout_ms: int = 15000,
) -> bool:

    try:
        target = page.get_by_role("button", name=EMAIL_LOGIN_PATTERN).first
        target.wait_for(state="visible", timeout=timeout_ms)
        target.click(timeout=10000)
        return True
    except Exception:
        pass

    # JS 回退
    try:

        clicked = page.evaluate(
            """
            (emailPattern) => {
                const visible = el =>
                    getComputedStyle(el).visibility === 'visible' &&
                    (el.offsetParent !== null || el.getClientRects().length > 0);
                const matches = (el, pattern) =>
                    visible(el) && pattern.test((el.innerText || '').trim());
                const pattern = new RegExp(emailPattern, 'i');
                const exact = new RegExp('^(?:' + emailPattern + ')$', 'i');
                const target =
                    Array.from(document.querySelectorAll('button, [role="tab"], a'))
                        .find(el => matches(el, pattern)) ||
                    Array.from(document.querySelectorAll('span, div'))
                        .find(el => matches(el, exact));

                if (target) {
                    target.click();
                    return true;
                }

                return false;
            }
            """,
            EMAIL_LOGIN_PATTERN.pattern,
        )

        if clicked:
            return True

    except Exception:
        pass

    return False


# ============================================================
# 自有节点 → 目标站连通性预测试
# ============================================================

def own_node_reaches_site(
    site_url: str,
) -> bool:

    """
    测试自有节点能否连通目标站点。

    仅判断传输层连通性：
    收到任何 HTTP 响应（含 WAF 拦截页）都算可达；
    只有超时 / 连接失败才算不可达。
    """

    proxies = {
        "http": PROXY_SERVER,
        "https": PROXY_SERVER,
    }

    try:

        requests.get(
            f"{site_url}/login",
            headers=BROWSER_HEADERS,
            proxies=proxies,
            timeout=PROBE_TIMEOUT,
            allow_redirects=True,
        )

        return True

    except Exception:
        return False


# ============================================================
# 浏览器登录
# ============================================================

class _LoginStageError(Exception):

    """
    登录流程阶段异常。

    只携带阶段码，不携带任何页面信息。
    """

    def __init__(self, stage: str):

        super().__init__(stage)

        self.stage = stage


def _first_visible_locator(
    page,
    selectors,
    timeout_ms: int = 4000,
):

    """
    依次尝试候选选择器，
    返回第一个可见的 Locator，找不到返回 None。
    """

    for selector in selectors:

        try:

            locator = page.locator(
                selector
            )

            if locator.count() == 0:
                continue

            locator.first.wait_for(
                state="visible",
                timeout=timeout_ms,
            )

            return locator.first

        except Exception:
            continue

    return None


def _valid_user_id(value):
    return type(value) is int and 1 <= value <= 2**53 - 1


def _url_origin(value):
    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    return scheme, parsed.hostname.encode("idna").decode("ascii").lower(), parsed.port or (443 if scheme == "https" else 80)


def _login_evidence(payload, username):
    if not isinstance(payload, dict) or payload.get("success") is not True:
        return {}
    data = payload.get("data")
    if not isinstance(data, dict):
        return {}
    user = data.get("user", data)
    if not isinstance(user, dict) or not _valid_user_id(user.get("id")):
        return {}
    names = [user.get(field) for field in ("username", "email") if user.get(field)]
    if names and not any(isinstance(name, str) and name.casefold() == username.casefold() for name in names):
        return {}
    evidence = {"user_id": user["id"]}
    token = data.get("access_token")
    if isinstance(token, str) and 1 <= len(token) <= 4096 and all(33 <= ord(char) <= 126 for char in token):
        evidence["access_token"] = token
    return evidence


def _browser_self(page, site, evidence):
    parsed = urlsplit(site)
    arguments = dict(evidence, origin=f"{parsed.scheme}://{parsed.netloc}")
    return page.evaluate(
        """
        async ({origin, user_id, access_token}) => {
            if (location.origin !== new URL(origin).origin) return {success: false};
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            try {
                if (!user_id) {
                    for (let attempt = 0; attempt < 10; attempt++) {
                        const user = JSON.parse(localStorage.getItem('user') || 'null');
                        if (Number.isSafeInteger(user?.id) && user.id > 0) {
                            user_id = user.id;
                            break;
                        }
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                if (!Number.isSafeInteger(user_id) || user_id <= 0) return {success: false};
                const headers = {'Accept': 'application/json', 'New-API-User': String(user_id)};
                if (access_token) headers.Authorization = 'Bearer ' + access_token;
                const response = await fetch('/api/user/self', {
                    method: 'GET', headers, credentials: 'include', cache: 'no-store',
                    redirect: 'error', signal: controller.signal
                });
                return {success: response.ok, status: response.status,
                        user_id, payload: await response.json()};
            } catch (_) {
                return {success: false};
            } finally {
                clearTimeout(timer);
            }
        }
        """, arguments,
    )


def browser_login_complete(
    account: dict,
    proxy: dict | None = None,
    profile: dict | None = None,
    isolated: bool = False,
) -> tuple:
    # --------------------------------------------------------
    # 代理配置
    # --------------------------------------------------------

    if isolated and not (proxy and proxy.get("server")):
        return None, "NODE_UNREACHABLE"

    proxy_config = None

    if proxy and proxy.get("server"):

        proxy_config = {
            "server": proxy["server"]
        }

    elif PROXY_SERVER:

        proxy_config = {
            "server": PROXY_SERVER
        }

        if PROXY_USERNAME and PROXY_PASSWORD:

            proxy_config["username"] = (
                PROXY_USERNAME
            )

            proxy_config["password"] = (
                PROXY_PASSWORD
            )

    # --------------------------------------------------------
    # 启动浏览器
    # --------------------------------------------------------

    result = None

    stage = "UNKNOWN"

    with sync_playwright() as p:

        browser = None

        try:

            browser = p.chromium.launch(

                headless=True,

                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-blink-features=AutomationControlled",
                ],

                proxy=proxy_config,
            )

            context_options = (dict(profile or {}) if isolated else {
                "viewport": {"width": 1920, "height": 1080},
                "user_agent": USER_AGENT,
            })
            context = browser.new_context(**context_options)

            page = context.new_page()
            login_evidence = {}

            def observe_login(response):
                try:
                    if (response.request.method == "POST" and 200 <= response.status < 300
                            and _url_origin(response.url) == _url_origin(account["site"])
                            and urlsplit(response.url).path
                            == urlsplit(account["site"]).path.rstrip("/") + "/api/user/login"):
                        login_evidence.update(_login_evidence(response.json(), account["username"]))
                except Exception:
                    pass

            # ------------------------------------------------
            # Step 1：访问登录页
            #
            # commit：收到首包即认为导航开始，
            # 页面内容由后续 WAF 等待逻辑轮询，
            # 避免慢代理下 domcontentloaded 直接超时。
            # 超时后重试一次。
            # ------------------------------------------------

            goto_done = False

            for _ in range(2):

                try:

                    page.goto(
                        f"{account['site']}/login",
                        wait_until="commit",
                        timeout=45000,
                    )

                    goto_done = True

                    break

                except PlaywrightTimeoutError:

                    continue

                except PlaywrightError as exc:
                    # Only fixed Chromium codes may leave the credential-bearing exception.
                    network_code = next((code for code in (
                        "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED",
                        "ERR_SOCKS_CONNECTION_FAILED", "ERR_NAME_NOT_RESOLVED",
                        "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_RESET",
                        "ERR_SSL_PROTOCOL_ERROR", "ERR_CERT_AUTHORITY_INVALID",
                    ) if f"net::{code}" in str(exc)), None)
                    if network_code:
                        log(f"NAVIGATION_FAIL: {network_code}")
                        raise _LoginStageError("NODE_UNREACHABLE") from None
                    raise

            if not goto_done:

                raise _LoginStageError(
                    "GOTO_TIMEOUT"
                )

            # ------------------------------------------------
            # Step 2：等待 WAF
            # ------------------------------------------------

            if not wait_for_waf_ready(
                page,
                context=context,
                timeout_ms=60000,
            ):

                raise _LoginStageError(
                    "WAF_TIMEOUT"
                )

            # ------------------------------------------------
            # 检查页面是否有登录表单输入框
            # ------------------------------------------------

            has_inputs = page.locator(
                f":is({LOGIN_FORM_INPUT_SELECTOR}):visible"
            ).count()

            # ------------------------------------------------
            # 没有输入框时切换登录方式
            # ------------------------------------------------

            if has_inputs == 0:

                clicked = click_email_login_button(
                    page
                )

                if not clicked:

                    # 不输出页面文本、HTML、URL
                    raise _LoginStageError(
                        "FORM_NOT_FOUND"
                    )

                page.wait_for_timeout(
                    1500
                )

            # ------------------------------------------------
            # Step 3：等待表单
            # ------------------------------------------------

            wait_result = page.evaluate(
                """
                async () => {

                    let attempts = 0;

                    const maxAttempts = 30;

                    while (
                        attempts < maxAttempts
                    ) {

                        const username =
                            document.querySelector(
                                'input#username, input[name="username"], input[name="email"], form input[type="text"]'
                            );

                        const password =
                            document.querySelector(
                                'input#password, input[name="password"], input[type="password"]'
                            );

                        const submit =
                            document.querySelector(
                                'button[type="submit"]'
                            );

                        const visible = el =>
                            el &&
                            (
                                el.offsetParent !== null ||
                                el.getClientRects().length > 0
                            );

                        if (
                            visible(username) &&
                            visible(password) &&
                            visible(submit)
                        ) {

                            return {
                                success: true
                            };
                        }

                        await new Promise(
                            resolve =>
                                setTimeout(
                                    resolve,
                                    500
                                )
                        );

                        attempts++;
                    }

                    return {
                        success: false
                    };
                }
                """
            )

            if not wait_result.get(
                "success"
            ):

                raise _LoginStageError(
                    "FORM_NOT_FOUND"
                )

            # ------------------------------------------------
            # 填写用户名
            # ------------------------------------------------

            try:

                username_locator = _first_visible_locator(
                    page,
                    USERNAME_SELECTORS,
                )

                if username_locator is None:

                    raise _LoginStageError(
                        "FORM_NOT_FOUND"
                    )

                username_locator.click(
                    timeout=5000
                )

                username_locator.fill(
                    account["username"],
                    timeout=5000,
                )

                # --------------------------------------------
                # 填写密码
                # --------------------------------------------

                password_locator = _first_visible_locator(
                    page,
                    PASSWORD_SELECTORS,
                )

                if password_locator is None:

                    raise _LoginStageError(
                        "FORM_NOT_FOUND"
                    )

                password_locator.click(
                    timeout=5000
                )

                password_locator.fill(
                    account["password"],
                    timeout=5000,
                )

                page.wait_for_timeout(
                    1000
                )

                # --------------------------------------------
                # Step 4：提交
                # --------------------------------------------

                submit_locator = _first_visible_locator(
                    page,
                    SUBMIT_SELECTORS,
                )

                if submit_locator is None:

                    raise _LoginStageError(
                        "FORM_NOT_FOUND"
                    )

                # Capture only this submitted login, not unrelated requests during page initialization.
                page.on("response", observe_login)
                submit_locator.click(
                    timeout=5000
                )

            except PlaywrightTimeoutError:

                raise _LoginStageError(
                    "FORM_OPERATE_TIMEOUT"
                )

            # ------------------------------------------------
            # Step 5：等待登录
            # ------------------------------------------------

            page.wait_for_timeout(
                3000
            )

            # 检查验证码
            has_captcha = page.evaluate(
                """
                () => !!document.querySelector(
                    '#nc_1_n1z, .nc-container, [class*="captcha"]'
                )
                """
            )

            if has_captcha:

                page.wait_for_timeout(
                    5000
                )

            # ------------------------------------------------
            # Step 6：获取用户信息
            # ------------------------------------------------

            api_result = _browser_self(page, account["site"], login_evidence)
            user_data = None
            if isinstance(api_result, dict) and api_result.get("success") is True:
                payload = api_result.get("payload")
                if isinstance(payload, dict) and payload.get("success") is True:
                    user_data = payload.get("data")
            authenticated_id = login_evidence.get("user_id")
            if isinstance(user_data, dict):
                requested_id = api_result.get("user_id")
                returned_id = user_data.get("id")
                if not _valid_user_id(returned_id) or not _valid_user_id(requested_id):
                    raise _LoginStageError("LOGIN_UNVERIFIED")
                if returned_id != requested_id or authenticated_id is not None and returned_id != authenticated_id:
                    raise _LoginStageError("AUTH_IDENTITY_MISMATCH")
                if authenticated_id is None:
                    if not user_data.get("username") and not user_data.get("email"):
                        raise _LoginStageError("LOGIN_UNVERIFIED")
                    if not _login_evidence({"success": True, "data": user_data}, account["username"]):
                        raise _LoginStageError("AUTH_IDENTITY_MISMATCH")
                authenticated_id = returned_id
            elif authenticated_id is None:
                raise _LoginStageError("USER_API_FAIL")

            quota = user_data.get("quota") if isinstance(user_data, dict) else None
            if type(quota) is not int or not 0 <= quota <= 2**63 - 1:
                quota = None
            api = account.get("api")
            if quota is None and isinstance(api, dict) and api.get("user_id") == authenticated_id:
                fallback = _browser_self(page, account["site"], api)
                payload = fallback.get("payload") if isinstance(fallback, dict) else None
                if (isinstance(fallback, dict) and fallback.get("success") is True
                        and isinstance(payload, dict) and payload.get("success") is True
                        and isinstance(payload.get("data"), dict)):
                    user_data = payload["data"]
                    if user_data.get("id") != authenticated_id or not _valid_user_id(user_data.get("id")):
                        raise _LoginStageError("AUTH_IDENTITY_MISMATCH")
                    candidate_quota = user_data.get("quota")
                    if type(candidate_quota) is int and 0 <= candidate_quota <= 2**63 - 1:
                        quota = candidate_quota
            result = {"quota": quota}
            if quota is None:
                result["authenticated"] = True
            if isolated and isinstance(user_data, dict):
                from account_observations import safe_user_group

                group = safe_user_group(user_data.get("group"))
                if group is not None:
                    result["user_group"] = group

            stage = "SUCCESS"

        except _LoginStageError as exc:

            stage = exc.stage

            result = None

        except PlaywrightTimeoutError:

            # 不打印 URL、页面信息、异常内容
            stage = "PAGE_TIMEOUT"

            result = None

        except Exception:

            # 不打印异常
            # browser 未创建成功说明是启动阶段失败
            if browser is None:

                stage = "BROWSER_LAUNCH_FAIL"

            else:

                stage = "UNEXPECTED"

            result = None

        finally:

            if browser is not None:

                try:
                    browser.close()
                except Exception:
                    pass

    return result, stage


# ============================================================
# 余额转换
# ============================================================

def format_balance(
    quota: int
) -> str:

    """
    quota 转换为美元。

    假设：
    500000 quota = $1
    """

    if quota is None:
        return "N/A"

    balance = quota / 500000

    return f"{balance:.2f}$"


# ============================================================
# 单账号签到
# ============================================================

def checkin_account(
    account: dict,
    total_accounts: int,
    label: str = "",
) -> tuple:

    last_stage = "UNKNOWN"

    # --------------------------------------------------------
    # 通道一：
    # 自有代理
    # --------------------------------------------------------

    if PROXY_SERVER:

        log(f"{label} 尝试自有节点登录")

        result, last_stage = browser_login_complete(
            account
        )

        if result:
            return result, last_stage

        log(
            f"{label} 尝试（自有节点）: "
            f"{last_stage}"
        )

    # --------------------------------------------------------
    # 通道二：
    # 免费代理池（按站点独立队列，耗尽自动重探）
    #
    # 每轮最多尝试 MAX_LOGIN_ATTEMPTS 个代理
    # （队列耗尽时随机提取新一批探测）；
    # 整轮登录全部失败后重新提取代理再试，
    # 最多 PROXY_LOGIN_ROUNDS 轮
    # --------------------------------------------------------

    pool_attempted = False

    for round_no in range(
        1,
        PROXY_LOGIN_ROUNDS + 1,
    ):

        for attempt_no in range(
            MAX_LOGIN_ATTEMPTS
        ):

            proxy = pop_proxy(
                account["site"],
                total_accounts,
            )

            if proxy is None:

                break

            pool_attempted = True

            # 代理已现场复检通过，开始登录
            # （IP 打码输出，避免完整泄露）
            log(
                f"{label} 使用代理 "
                f"{mask_proxy(proxy)} 登录"
                f"（第{round_no}"
                f"/{PROXY_LOGIN_ROUNDS}轮 "
                f"尝试{attempt_no + 1}"
                f"/{MAX_LOGIN_ATTEMPTS}）"
            )

            result, last_stage = browser_login_complete(
                account,
                proxy,
            )

            if result:
                return result, last_stage

            log(
                f"{label} 第{round_no}轮"
                f"尝试{attempt_no + 1}"
                f"（代理池）: {last_stage}"
            )

        # 代理池已被标记不可用时，
        # 后续轮次不会再拿到代理，直接结束
        if account["site"] in POOL_BROKEN_SITES:

            break

    if not pool_attempted:

        last_stage = "NO_PROXY"

    # --------------------------------------------------------
    # 兜底：
    # 未配置自有节点时，代理池不可用或
    # 全部尝试失败后，再尝试一次直连登录
    #
    # 每个站点只直连兜底一次：
    # 直连失败说明 Runner IP 已被拦截，
    # 后续账号重复直连只会白耗时间
    # --------------------------------------------------------

    if (
        not PROXY_SERVER
        and account["site"]
        not in DIRECT_FAILED_SITES
    ):

        log(f"{label} 尝试直连登录（兜底）")

        result, last_stage = browser_login_complete(
            account
        )

        if result:
            return result, last_stage

        DIRECT_FAILED_SITES.add(
            account["site"]
        )

        log(
            f"{label} 尝试（直连兜底）: "
            f"{last_stage}，本站点后续不再直连"
        )

    return None, last_stage


# ============================================================
# 主签到逻辑
# ============================================================

def _safe_login_result(result: dict | None, stage: str) -> tuple:
    from report import STAGES

    if result is not None and not isinstance(result, dict):
        return None, "UNEXPECTED"
    if not isinstance(stage, str) or stage not in STAGES:
        return None, "UNEXPECTED"
    if stage != "SUCCESS":
        return None, stage
    if result:
        quota = result.get("quota")
        if type(quota) is int and 0 <= quota <= 2**63 - 1:
            return quota, "SUCCESS"
        if quota is None:
            return (None, "SUCCESS") if result.get("authenticated") is True else (None, "UNEXPECTED")
        return None, "QUOTA_INVALID"
    return None, stage if isinstance(stage, str) and stage in STAGES and stage != "SUCCESS" else "UNEXPECTED"


def checkin_assigned_account(account: dict, candidates: list[dict], profile: dict,
                             observations: dict | None = None) -> tuple:
    last_stage = "PROXY_LIST_EXHAUSTED"
    for attempt, candidate in enumerate(candidates, 1):
        if not candidate.get("server"):
            continue
        try:
            result, stage = browser_login_complete(
                account, proxy=candidate, profile=profile, isolated=True
            )
        except Exception:
            result, stage = None, "UNEXPECTED"
        if observations is not None:
            from account_observations import query_exit_ip

            observations["exit_ip"] = query_exit_ip(candidate)
        quota, last_stage = _safe_login_result(result, stage)
        if last_stage == "SUCCESS":
            from account_observations import safe_user_group

            safe_result = {"quota": quota}
            if quota is None:
                safe_result["authenticated"] = True
            group = safe_user_group(result.get("user_group"))
            if group is not None:
                safe_result["user_group"] = group
            return safe_result, last_stage
        log(f"{account.get('id', 'account')} attempt{attempt}: {last_stage}")
    return None, last_stage


def run_checkin(notify: bool = True, manifest_group: dict | None = None,
                result_path: Path | None = None):
    from report import write_report

    accounts = parse_accounts()
    if not accounts:
        log("ACCOUNT_CONFIG_FAIL")
        sys.exit(1)
    total = len(accounts)
    rows = []
    if manifest_group is not None:
        if len(manifest_group["account_ids"]) != total or result_path is None:
            raise ValueError("ROUTE_CONFIG_FAIL")
        rows = [{"id": account_id, "quota": None, "stage": "UNFINISHED"}
                for account_id in manifest_group["account_ids"]]
        write_report(result_path, manifest_group, rows)
    results, success_count, site_counters = [], 0, {}
    log(f"ACCOUNT_COUNT: {total}")
    for index, account in enumerate(accounts):
        site = account["site"]
        site_counters[site] = site_counters.get(site, 0) + 1
        label = f"{mask_site(site)} Account{site_counters[site]}"
        try:
            result, stage = checkin_account(account, total, label)
        except Exception:
            result, stage = None, "UNEXPECTED"
        quota, stage = _safe_login_result(result, stage)
        balance = format_balance(quota) if quota is not None else None
        results.append((label, balance, stage))
        if rows:
            rows[index].update(quota=quota, stage=stage)
            write_report(result_path, manifest_group, rows)
        log(f"{label}: {stage}" + (f" {balance}" if balance is not None else ""))
        if stage == "SUCCESS":
            success_count += 1
            if index < total - 1:
                time.sleep(random.uniform(3, 8))
    if notify:
        send_notifications(*format_notifications(results, success_count, total))
    if success_count < total:
        sys.exit(1)


def run_isolated_group(routes: list[dict], manifest_group: dict, result_path: Path,
                       subscription_url: str = "") -> int:
    from proxy_runtime import download_binary, group_proxy, load_node_links, parse_node_link
    from report import write_report

    by_id = {account["id"]: account for account in routes}
    if set(by_id) != set(manifest_group["account_ids"]) or len(routes) != len(by_id):
        raise ValueError("ROUTE_CONFIG_FAIL")
    rows = [{"id": account_id, "quota": None, "stage": "UNFINISHED"}
            for account_id in manifest_group["account_ids"]]
    write_report(result_path, manifest_group, rows)
    nodes = {}
    if any("node" in candidate for account in routes for candidate in account["proxies"]):
        try:
            nodes = load_node_links(subscription_url)
        except Exception:
            log("NODE_SOURCE_FAIL")
    outbounds, candidate_tags = {}, {}
    for account in routes:
        tags = []
        for index, candidate in enumerate(account["proxies"], 1):
            tag = f"{account['id']}_p{index:02}"
            if "outbound" in candidate:
                outbounds[tag] = dict(candidate["outbound"], tag=f"out-{tag}")
                tags.append(tag)
                continue
            link = candidate.get("link") or nodes.get(candidate.get("node"))
            if link is None:
                log(f"{account['id']} candidate{index}: NODE_MISSING")
                continue
            try:
                outbounds[tag] = parse_node_link(link, f"out-{tag}")
                tags.append(tag)
            except Exception:
                log(f"{account['id']} candidate{index}: NODE_CONFIG_FAIL")
        candidate_tags[account["id"]] = tags
    if not outbounds:
        for row in rows:
            row["stage"] = "PROXY_LIST_EXHAUSTED"
        write_report(result_path, manifest_group, rows)
        return 1
    runtime_parent = os.environ.get("RUNNER_TEMP") or None
    try:
        with tempfile.TemporaryDirectory(prefix="checkin-proxy-", dir=runtime_parent) as directory:
            runtime_dir = Path(directory)
            binary = download_binary(platform.system(), platform.machine(), runtime_dir)
            with group_proxy(outbounds, binary, runtime_dir) as endpoints:
                for row in rows:
                    account = by_id[row["id"]]
                    candidates = [{"server": endpoints[tag]} for tag in candidate_tags[row["id"]]
                                  if tag in endpoints]
                    observations = {}
                    result, stage = checkin_assigned_account(account, candidates, account["profile"],
                                                            observations=observations)
                    quota, stage = _safe_login_result(result, stage)
                    row.update(quota=quota, stage=stage, exit_ip=observations.get("exit_ip"))
                    if result and "user_group" in result:
                        row["user_group"] = result["user_group"]
                    write_report(result_path, manifest_group, rows)
                    log(f"{row['id']}: {stage}")
    except Exception:
        for row in rows:
            if row["stage"] == "UNFINISHED":
                row["stage"] = "PROXY_START_FAIL"
        write_report(result_path, manifest_group, rows)
    return int(any(row["stage"] != "SUCCESS" for row in rows))


# ============================================================
# Main
# ============================================================

def _random_accounts(config: dict, plan: dict | None = None) -> list[dict]:
    from subscription_pool import load_pool, make_plan, resolve_random_accounts, validate_plan

    if plan is not None:
        validate_plan(plan)
    require_names = any("node" in p for a in config["accounts"] for p in a["proxies"])
    names, nodes = load_pool(config["subscription_url"], require_names=require_names)
    if plan is None:
        plan = make_plan(config, names, nodes)
    return resolve_random_accounts(config, plan, names, nodes)


def _write_group_failure(group: dict, path: Path, stage: str) -> None:
    from report import write_report

    write_report(path, group, [{"id": account_id, "quota": None, "stage": stage}
                               for account_id in group["account_ids"]])


def main():
    from routing import RUNNERS, build_manifest, parse_config

    worker = bool(os.environ.get("GROUP_ID") or os.environ.get("CHECKIN_MODE"))
    raw = os.environ.get("CHECKIN_CONFIG")
    notification_config = None
    try:
        mode = os.environ.get("CHECKIN_MODE")
        if mode not in (None, "legacy", "isolated"):
            raise ValueError("ROUTE_CONFIG_FAIL")
        if mode == "legacy" and raw not in (None, ""):
            raise ValueError("ROUTE_CONFIG_FAIL")
        legacy = mode == "legacy" or (raw is None and mode != "isolated")
        if legacy:
            if worker:
                group = {"group_id": os.environ["GROUP_ID"], "os": os.environ["RUNNER_KEY"],
                         "account_ids": json.loads(os.environ["ACCOUNT_IDS"]), "mode": "legacy"}
                if group["os"] != RUNNERS["ubuntu"] or platform.system() != "Linux":
                    raise ValueError("ROUTE_CONFIG_FAIL")
                run_checkin(notify=False, manifest_group=group,
                            result_path=Path(os.environ["RESULT_PATH"]))
            else:
                run_checkin()
            return
        config = parse_config(raw)
        from subscription_pool import has_random

        notification_config = config["notifications"]
        manifest = build_manifest(config["accounts"])
        by_id = {account["id"]: account for account in config["accounts"]}
        host_os = {"Linux": "ubuntu", "Windows": "windows", "Darwin": "macos"}.get(platform.system())
        if worker:
            group = next(g for g in manifest["groups"] if g["group_id"] == os.environ["GROUP_ID"])
            if (group["account_ids"] != json.loads(os.environ["ACCOUNT_IDS"])
                    or group["os"] != os.environ["RUNNER_KEY"] or group["os"] != RUNNERS.get(host_os)):
                raise ValueError("ROUTE_CONFIG_FAIL")
            if has_random(config["accounts"]) or os.environ.get("RANDOM_PLAN"):
                try:
                    if not has_random(config["accounts"]) or not os.environ.get("RANDOM_PLAN"):
                        raise ValueError("RANDOM_POOL_FAIL")
                    plan = json.loads(os.environ["RANDOM_PLAN"])
                    by_id = {a["id"]: a for a in _random_accounts(config, plan)}
                except Exception:
                    _write_group_failure(group, Path(os.environ["RESULT_PATH"]), "RANDOM_POOL_FAIL")
                    log("RANDOM_POOL_FAIL")
                    sys.exit(1)
            code = run_isolated_group([by_id[i] for i in group["account_ids"]], group,
                                      Path(os.environ["RESULT_PATH"]), config["subscription_url"])
            sys.exit(code)
        if any(account["os"] != host_os for account in config["accounts"]):
            raise ValueError("ROUTE_CONFIG_FAIL")
        from report import combine_reports, observe_balances

        with tempfile.TemporaryDirectory(prefix="checkin-results-") as directory:
            root = Path(directory)
            random_failed = False
            if has_random(config["accounts"]):
                try:
                    by_id = {a["id"]: a for a in _random_accounts(config)}
                except Exception:
                    random_failed = True
                    log("RANDOM_POOL_FAIL")
            for group in manifest["groups"]:
                result_dir = root / f"checkin-results-{group['group_id']}"
                result_dir.mkdir()
                if random_failed:
                    _write_group_failure(group, result_dir / "result.json", "RANDOM_POOL_FAIL")
                else:
                    run_isolated_group([by_id[i] for i in group["account_ids"]], group,
                                       result_dir / "result.json", config["subscription_url"])
            results = combine_reports(manifest, root, details=True)
            history_path = Path(os.environ.get("BALANCE_HISTORY_PATH", ".superpowers/checkin-history/balances.json"))
            results = observe_balances(results, config, history_path)
            count = sum(stage == "SUCCESS" for _, _, stage in results)
            send_notifications(*format_notifications(results, count, len(results)),
                               config=notification_config, wecom_markdown=True)
            sys.exit(int(count != len(results)))
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        log("SCRIPT_FAIL")
        if not worker and (raw is None or notification_config is not None):
            send_notifications("<b>Check-in failed</b>", "Check-in failed", config=notification_config)
        sys.exit(1)


# ============================================================
# Entry
# ============================================================

if __name__ == "__main__":
    main()
