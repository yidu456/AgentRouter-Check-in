# AgentRouter 自动签到

GitHub Actions 使用 Playwright Chromium 和 Xray 代理登录完成签到；支持多个账号、Ubuntu / macOS / Windows、账号独立代理与基本浏览器配置，全部结束后统一发送 Telegram / 企业微信通知。

## 快速开始

1. Fork 本仓库并同步最新 `main`，在 **Actions** 启用工作流。
2. 在 **Settings → Secrets and variables → Actions** 新建 **Secret `CHECKIN_CONFIG`**，填写以下 JSON 并替换虚构账号和代理。
3. 打开 **Actions → Ayrouter Daily Check-in → Run workflow**。这会真实登录并可能发送通知；请先核对配置。
4. 最终汇总在 `notify` 任务。默认 GitHub 定时为北京时间 **06:45**，平台可能延迟；随机启动见下节 Cloudflare。

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
          "profile": {"viewport": {"width": 1440, "height": 900}, "locale": "zh-CN"}
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

每个候选节点登录前，先通过该代理检测出口 IP，再查询国家和具体 IANA 时区，用检测到的时区创建浏览器。无需填写 `profile.timezone_id`；换节点会重新检测。IP 或时区查询失败就跳过该节点，所有候选失败则不登录，不用默认时区或直连兜底。

完整字段、订阅随机节点、协议链接、固定 profile 和可选网站管理 API 凭据见 **[配置手册](docs/configuration.md)**。不要填写 Clash YAML、Xray 内核配置，也不要把真实凭据提交到仓库。

## Cloudflare 随机触发与管理

Cloudflare 只启动 GitHub Actions，不在 Worker 内运行浏览器。每个仓库目标、每个日期独立抽取北京时间 **01:00～23:00**，Actions 不提前启动等待。支持多个 GitHub owner，需分别配置 PAT。

按 **[Cloudflare 部署指南](cloudflare/README.md)** 完成：

1. Workers Builds 连接自己的仓库：生产分支 `main`，Root directory `cloudflare`，Build `npm test`，Deploy `npm run deploy`。
2. Worker 运行时设置 `TRIGGER_CONFIG`、GitHub PAT；不要填在 Build variables。令牌创建步骤见 **[令牌指南](cloudflare/API-TOKENS.md)**。
3. 设置 `DEBUG_ACCESS_TOKEN`（隐藏入口值）、`ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。`/` 只有 `hello world`，打开 **`/<入口值>`** 用用户名密码登录，不是固定 `/token`。
4. 管理页分为 **仓库管理 / 配置检查 / 运行日志**，分别显示操作和下次时间、错误字段与建议、按仓库分类的调度记录。
5. 准备启用 Cloudflare 时，删除各目标默认分支旧 `on.schedule`，保留 `workflow_dispatch`，否则两套定时都可能运行。项目不会自动删除你的 Cron。

新目标默认开启；明确 `enabled:false` 和已有数据库关闭状态不重置。手动运行需要确认，日志删除不改变日程。Worker 企业微信通知仅说明 GitHub 是否受理触发，不是 Actions 已完成或签到成功。

## 成功与余额怎么理解

“登录成功”必须来自网站的登录/当前用户身份验证，不是脚本退出码，也不能仅凭额度字段推断。余额读取失败与登录失败分开显示。

- **上次余额**来自上次成功取得并保存的额度；**余额变化**是本次余额减上次余额，是两次观测间的净变化，不保证全部为签到奖励。
- 历史只保存匿名身份键与额度，通过 Actions cache 跨运行恢复。首次运行、身份改变、缓存缺失/清理或读写失败时不能倒推出上次余额，会明确提示原因；保留稳定 `id`、`site`、`username`。
- 默认复用浏览器登录态读取网站用户信息，不需要另配 API 密钥。可选网站账户管理 token 只补充已确认账号的余额，不替代登录，不使用模型调用 `sk-` Key。
- 用户分组优先读取网站返回字段；新模式的出口国家/IP 复用登录前的代理探测，不在汇总阶段重新查询。IP 可点击到 IPPure；动态出口和 IP 定位误差仍可能使检测与实际登录出口不一致。

如历史持续不可用，查看 `notify` 中历史 restore/save 步骤的安全状态码，不要发密钥或原始响应。

## 常见错误

| 状态 | 含义 / 检查方向 |
| --- | --- |
| `ROUTE_CONFIG_FAIL` | CHECKIN_CONFIG 格式或字段不合法，按配置手册核对 |
| `NODE_CONFIG_FAIL` | 节点协议/参数无法转换为当前 Xray 支持配置 |
| `EXIT_IP_FAIL` / `TIMEZONE_LOOKUP_FAIL` | 登录前无法确认代理出口 IP／国家和有效时区，已跳过该候选；检查节点和查询服务可用性 |
| `PROXY_LIST_EXHAUSTED` | 此账号所有候选不可用；先检查链接、节点出口和订阅 |
| `FORM_NOT_FOUND` | 未找到登录表单，可能页面结构、WAF 或加载异常 |
| `LOGIN_UNVERIFIED` / `USER_API_FAIL` | 无法取得可信登录/身份证据，不当作成功 |
| `AUTH_IDENTITY_MISMATCH` | 返回身份与本次登录身份不匹配，不使用该余额 |
| Cloudflare 入口 404 / JSON 错误 | 核对运行时变量和最新部署，在配置栏查看建议 |

不要根据“登录成功”推断奖励到账；确认当前余额和历史观测差额。固定基本 profile 不等于完整硬件指纹，Runner、Chromium版本、字体、GPU/IP信誉仍可能变化，也不保证账号完全无关联。

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
