# AgentRouter 自动签到

GitHub Actions 使用 Playwright Chromium 和 Xray 代理登录完成签到；支持多个账号、Ubuntu / macOS / Windows、账号独立代理与基本浏览器配置，全部结束后统一发送 Telegram / 企业微信通知。

## 快速开始

1. Fork 本仓库并同步最新 `main`，在 **Actions** 启用工作流。
2. 在 **Settings → Secrets and variables → Actions** 新建 **Secret `CHECKIN_CONFIG`**，填写以下 JSON 并替换虚构账号和代理。
3. 打开 **Actions → Ayrouter Daily Check-in → Run workflow**。这会真实登录并可能发送通知；请先核对配置。
4. 最终汇总在 `notify` 任务。GitHub 内置定时默认关闭，保留手动运行；自动随机启动见下节 Cloudflare。

```json
{
  "version": 2,
  "groups": {
    "ubuntu": {
      "accounts": [
        {
          "id": "ubuntu01",
          "username": "user1@example.com",
          "password": "example-secret-one",
          "proxies": [{"link": "socks5://proxy1.example.com:1080"}]
        }
      ]
    },
    "macos": {
      "accounts": [
        {
          "id": "mac01",
          "username": "user2@example.com",
          "password": "example-secret-two",
          "proxies": [{"link": "socks5://proxy2.example.com:1080"}],
          "profile": {"viewport": {"width": 1440, "height": 900}, "locale": "auto"}
        }
      ]
    },
    "windows": {"accounts": []}
  },
  "notifications": {
    "wecom": {"webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"}
  }
}
```

不用的 OS 组或通知渠道可以删除。每组可放多个账号，每个账号必须有自己的 1～N 个代理，首次成功后停止尝试；不回退免费节点或直连。`version:1` 的顶层 `accounts` + 每账号 `os` 格式仍兼容。

有 `random` 时，prepare 每轮只获取一次订阅，所有系统使用同一份加密节点池快照，不再重新下载订阅。无需新增 JSON 字段或 Secret；下一轮重新下载、重新抽取。快照只以密文保存为保留 1 天的 Actions artifact，配置或快照校验失败仍不登录。

每个候选节点登录前，先通过该代理检测出口 IP，再查询国家和具体 IANA 时区，用检测到的时区创建浏览器。无需填写 `profile.timezone_id`；换节点会重新检测。IP 或时区查询失败就跳过该节点，所有候选失败则不登录，不用默认时区或直连兜底。

`profile.locale: "auto"` 会随新节点的国家切换语言：SG→`en-SG`、KR→`ko-KR`、JP→`ja-JP`、DE→`de-DE`、US→`en-US`、HK→`zh-HK`，其他国家用 `en-US`。显式固定 `zh-CN`/`en-US` 不变；省略仍默认 `zh-CN`。不同节点可能共用出口 IP，不能保证独立出口。

完整字段、订阅随机节点、协议链接、固定 profile 和可选网站管理 API 凭据见 **[配置手册](docs/configuration.md)**。不要填写 Clash YAML、Xray 内核配置，也不要把真实凭据提交到仓库。

## Cloudflare 随机触发与管理

Cloudflare 只启动 GitHub Actions，不在 Worker 内运行浏览器。每个目标支持每天 **1～24 次**固定时间或窗口内随机触发；省略 `schedule` 默认每天一次、北京时间 **01:00～23:00** 随机。Actions 不提前启动等待，多个 GitHub owner 分别配置 PAT。

按 **[Cloudflare 部署指南](cloudflare/README.md)** 完成：

1. Workers Builds 连接自己的仓库：生产分支 `main`，Root directory `cloudflare`，Build `npm test`，Deploy `npm run deploy`。
2. Worker 运行时设置 `TRIGGER_CONFIG`、GitHub PAT；不要填在 Build variables。令牌创建步骤见 **[令牌指南](cloudflare/API-TOKENS.md)**。
3. 设置 `DEBUG_ACCESS_TOKEN`（隐藏入口值）、`ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。`/` 只有 `hello world`，打开 **`/<入口值>`** 用用户名密码登录，不是固定 `/token`。
4. 管理页分为 **仓库管理 / 配置检查 / 运行日志**，分别显示操作与已保存时段、可视化状态卡/目标表格/高亮错误字段、按仓库分类的调度记录。安全会话有效 12 小时，刷新无需重新输入密码。
5. 确认各目标默认分支的旧 `on.schedule` 已关闭，保留 `workflow_dispatch`。当前版本默认关闭内置 Cron；如果你另行开启，两套定时都可能运行。

新目标默认开启；首次登录管理页会为已开启且 Token 有效的新目标保存未来日程，无需关闭再开启。刷新不重新抽时间，也不立即触发；缺失的未来 Alarm 可按原时间恢复。明确 `enabled:false` 和已有数据库关闭状态不重置。手动运行不占自动次数，日志删除不改变日程。Worker 企业微信仅说明 GitHub 是否受理触发，不是 Actions 已完成或签到成功。固定/随机填写规则与升级回退注意事项见部署指南。

## 成功与余额怎么理解

“登录成功”必须来自网站的登录/当前用户身份验证，不是脚本退出码，也不能仅凭额度字段推断。余额读取失败与登录失败分开显示。

- **上次余额**来自上次成功取得并保存的额度；**余额变化**是本次余额减上次余额，是两次观测间的净变化，不保证全部为签到奖励。
- 历史只保存匿名身份键与额度，通过 Actions cache 跨运行恢复。首次运行、身份改变、缓存缺失/清理或读写失败时不能倒推出上次余额，会明确提示原因；保留稳定 `id`、`site`、`username`。
- 默认复用浏览器登录态读取网站用户信息，不需要另配 API 密钥。可选网站账户管理 token 只补充已确认账号的余额，不替代登录，不使用模型调用 `sk-` Key。
- 用户分组优先读取网站返回字段；新模式的出口国家/IP 复用登录前的代理探测，不在汇总阶段重新查询。Telegram 提供原生“复制 IP”按钮；企业微信显示纯 IP，供长按或选中复制，不再跳转 IPPure。
- 通知末行显示最终汇总生成时间，使用北京时间 UTC+8；不是运行耗时。失败结果也有中文原因和处理建议。

如历史持续不可用，查看 `notify` 中历史 restore/save 步骤的安全状态码，不要发密钥或原始响应。

## 常见错误

| 状态 | 含义 / 检查方向 |
| --- | --- |
| `ROUTE_CONFIG_FAIL` | 准备阶段失败；看紧随其后的 `PREPARE_DIAGNOSTIC` 字段位置、原因和计数，不能仅凭此码认定 JSON 有错 |
| `NODE_CONFIG_FAIL` | 节点协议/参数无法转换为当前 Xray 支持配置 |
| `PROXY_START_FAIL` | 看同一步的 `PROXY_DIAGNOSTIC` 和 `ISOLATED_DIAGNOSTIC`，区分下载、校验、端口或启动问题；不是必然节点故障 |
| `EXIT_IP_FAIL` / `TIMEZONE_LOOKUP_FAIL` | 登录前无法确认代理出口 IP／国家和有效时区，已跳过该候选；检查节点和查询服务可用性 |
| `PROXY_LIST_EXHAUSTED` | 此账号所有候选不可用；先检查链接、节点出口和订阅 |
| `FORM_NOT_FOUND` | 未找到登录表单，可能页面结构、WAF 或加载异常 |
| `LOGIN_UNVERIFIED` / `USER_API_FAIL` | 无法取得可信登录/身份证据，不当作成功 |
| `AUTH_IDENTITY_MISMATCH` | 返回身份与本次登录身份不匹配，不使用该余额 |
| Cloudflare 入口 404 / JSON 错误 | 核对运行时变量和最新部署，在配置栏查看建议 |

不要根据“登录成功”推断奖励到账；确认当前余额和历史观测差额。固定基本 profile 不等于完整硬件指纹，Runner、Chromium版本、字体、GPU/IP信誉仍可能变化，也不保证账号完全无关联。

准备失败时，新日志只显示安全字段和数字，例如 `reason=SUBSCRIPTION_HTTP_ERROR status=403`，或 `reason=POOL_TOO_SMALL available=11 requested=12`，不打印订阅、节点、账号或密码。详细原因见配置手册。排障请新建一次 **Run workflow → main**；重跑旧记录会继续使用旧提交。

Actions 日志、错误标注和 Summary 同时给出中文原因与处理办法。例如 Windows 首账号的 `id` 无效时，会说明“1～32 个字符、英文字母开头、仅含字母数字及 `_`/`-`”。`EXIT_DIAGNOSTIC` 区分出口查询 HTTP 错误、超时、无效响应等；随后明确显示换到哪个候选，全部用尽才失败，不在同一个节点反复查询。

登录任务失败时，代理日志也只输出固定阶段码和候选计数。`NATIVE_CHECK_REJECTED` 表示 Xray 拒绝配置，`PORT_READY status=FAIL` 表示本地代理就绪超时；`ISOLATED_DIAGNOSTIC phase=ACCOUNT_RUN` 表示账号执行异常，不再误标为代理启动失败。`link` 和 `random` 仍一起初始化，再按配置顺序登录；此诊断改动不是“失败后才启动备用”的改造。

`RANDOM_POOL_FAIL` 后看 `RANDOM_DIAGNOSTIC`：`SNAPSHOT_MISSING` 表示加密池工件缺失，`SNAPSHOT_INVALID` 表示损坏或配置/运行绑定不匹配，`RANDOM_PLAN_MISMATCH` 表示计划与有效节点不一致；这些都不是浏览器指纹异常。订阅 HTTP/超时诊断现在在 prepare 或本地运行中出现，worker 不再请求订阅。Xray 下载仅 HTTP 502/503/504 或明确超时最多尝试 3 次，重试前分别等待 2/4 秒，仍校验固定版本 SHA-256，不换镜像或绕过校验。

VLESS + WS + 普通 TLS 自动移除 `fp`、`ech` 后复用原解析器，保留 TLS/SNI/Host/路径/已有 Early Data；移除 ECH 会失去隐藏 TLS 服务名的保护。XHTTP 仍跳过，不转换成 WS；完整限制见配置手册第 6.1 节。

## 旧配置与本地验证

旧模式仍支持 `ACCOUNTS`（如 `https://agentrouter.org|user@example.com:example-secret`）或 `USERNAME` / `PASSWORD`，以及 `TG_BOT_TOKEN` / `TG_CHAT_ID`。非空 `CHECKIN_CONFIG` 不与旧变量混用；严格独立代理请使用新模式，不要清空 Secret 来绕过错误。

本地使用 Python 3.11 或更新：

```sh
python -m pip install requests playwright==1.64.1 pynacl pysocks tzdata
python -m playwright install chromium
python -m unittest discover -s tests
python -m py_compile app.py routing.py report.py
bash -n setup-proxy.sh
npm ci --prefix cloudflare
npm test --prefix cloudflare
npm run check --prefix cloudflare
```

测试模拟网络和浏览器；`python app.py`、Actions Run workflow、管理页手动运行会产生真实业务请求，不能当作无副作用语法测试。Cloudflare dry-run 只打包，不部署。
