# AgentRouter 自动签到脚本

每天自动登录 [AgentRouter](https://agentrouter.org/register?aff=Rm0L) 完成签到，获取每日奖励。

## ⚙️ 功能特性

- ✅ 使用账号密码自动登录（登录即签到）
- ✅ 多账号 / 多站点支持：`ACCOUNTS` 多行配置（可带站点前缀），逐账号顺序签到，汇总 Telegram 通知
- ✅ 新模式：一个 `CHECKIN_CONFIG` 变量配置所有账号、系统、代理列表和通知
- ✅ 固定系统分组：Ubuntu / Windows / macOS，每组最多 3 个账号
- ✅ 每账号 1～N 个代理，按顺序尝试，首次成功后停止；新模式不回退免费代理或直连
- ✅ 统一使用 Xray 内核；旧模式优先自有节点，失败自动回退免费代理池
- ✅ 代理池 WAF 探测：随机抽样并发检测 IP 是否触发阿里云 WAF（按站点独立探测）
- ✅ 所有分组结束后统一汇总到 Telegram / 企业微信群机器人（均可选）
- ✅ GitHub Actions 自动运行（每天北京时间 06:45；实际启动可能受平台调度延迟影响）

## 推荐配置：一个变量配置所有账号

在仓库 **Settings → Secrets and variables → Actions** 添加 Secret：`CHECKIN_CONFIG`，内容为 JSON。下面均为虚构示例，需要替换；没有使用的通知渠道可以删掉，`notifications` 也可省略。

```json
{
  "version": 1,
  "subscription_url": "https://subscription.example.com/example",
  "notifications": {
    "telegram": {
      "bot_token": "example-token",
      "chat_id": "example-chat"
    },
    "wecom": {
      "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"
    }
  },
  "accounts": [
    {
      "id": "a01",
      "site": "https://agentrouter.org",
      "username": "user1@example.com",
      "password": "example-secret:with-colon",
      "os": "ubuntu",
      "proxies": [{"node": "node-a"}, {"node": "node-b"}],
      "profile": {
        "viewport": {"width": 1440, "height": 900},
        "screen": {"width": 1440, "height": 900},
        "device_scale_factor": 1,
        "locale": "zh-CN",
        "timezone_id": "Asia/Shanghai",
        "color_scheme": "light"
      }
    },
    {
      "id": "a02",
      "username": "user2@example.com",
      "password": "example-secret-two",
      "os": "macos",
      "proxies": [{"link": "socks5://proxy.example.com:1080#dedicated-node"}]
    },
    {
      "id": "a03",
      "username": "user3@example.com",
      "password": "example-secret-three",
      "os": "windows",
      "proxies": [{"node": "node-c"}]
    }
  ]
}
```

### 账号和代理规则

- 每个账号的 `id` 必须唯一，以字母开头、最多 32 个字母/数字/下划线/短横线；请勿把邮箱或密钥作为 ID，它会显示在任务和通知中。
- `os` 只能为 `ubuntu`、`windows`、`macos`，对应固定标签 `ubuntu-24.04`、`windows-2022`、`macos-15`（ARM64）。`macos-14` 已退役，不再使用。同系统账号按 ID 排序，每组最多 3 个；不同分组使用独立 Runner。同一账号不会每天随机更换系统。
- `site` 可省略，默认 `https://agentrouter.org`。JSON 密码完整保留，包括冒号、竖线和两端空格。
- `proxies` 必须配置 1～N 个候选。每个候选只写 `node` 或 `link`，不能同时写。`node` 使用共用订阅中的节点名称；`link` 为完整节点分享链接，无须订阅。只使用直接链接时可省略 `subscription_url`。
- 订阅名称来自分享链接的 `#名称`（URL 解码后），VMess 可使用 `ps`；订阅中重名节点会被拒绝。节点引用、相同直接链接不能重复分配给多个账号。
- 每次从列表第一个候选开始，失败后关闭浏览器并尝试该账号下一个候选。首次成功即停止，不会为了遍历代理再次登录。全部失败只影响该账号，不使用未配置节点、免费代理或直连。
- 当前支持明文/base64/base64url 的节点链接订阅及 vless、vmess、trojan、hysteria2/hy2、socks5/socks。不是任意 Clash YAML / sing-box JSON 订阅都能解析；不支持的节点会报告失败，不会静默降级 TLS。
- Hysteria2 的 Salamander 混淆密码至少需要 4 个 UTF-8 字节；不兼容配置会提前拒绝，避免影响同组其他候选。
- VLESS WebSocket 支持 `ed` Early Data，转换为 Xray 的路径 `ed` 参数；`eh` 仅支持 Xray 固定的 `Sec-WebSocket-Protocol`。路径中的 `ed` 与外层参数冲突、启用 Early Data 却指定空/自定义头、Reality + WebSocket 等不能正确转换的组合会明确失败，不会静默忽略。保留其余路径查询、Host、SNI 和明确配置的证书校验策略。VLESS 用户 ID 必须是有效完整 UUID，不能使用截断后的脱敏值；请从客户端复制完整节点链接。
- `profile` 可省略：默认 1440×900、像素比例 1、`zh-CN`、`Asia/Shanghai`、浅色。可固定视口/屏幕、像素比例 1/2、语言 `zh-CN`/`en-US`、时区 `Asia/Shanghai`/`Asia/Tokyo`/`America/New_York`/`Europe/London` 和 `light`/`dark`。
- 使用真实系统 Chromium 的默认 UA，不在 Linux 上伪装 macOS。不同节点不保证不同出口 IP；基本配置固定也不代表完整硬件指纹固定或账号不可关联。

### 最终汇总通知

全部系统分组成功、失败或超时结束后，`notify` 任务才汇总发送；账号和分组执行期间不发送消息。缺失或损坏的报告计入失败，不会默认为成功。汇总只包含公开 ID、系统、余额和安全状态码，不包含账号密码、代理链接或响应详情。

新模式从完整校验后的配置确定预期分组；即使汇总清单下载失败，也能按预期账号恢复汇总。旧模式无法恢复清单时，只发送安全的清单异常通知。所有分支共用一个签到并发锁，避免默认分支定时任务与开发分支手动任务同时登录同一批账号。

工作流按 `prepare → plan → checkin → notify` 执行。读取凭据的 `prepare` 只上传安全清单，不发送跨任务输出；独立的 `plan` 不引用账号 Secrets，矩阵只含系统和数字槽位。账号 ID 在签到任务内从清单校验后读取，避免完整配置与矩阵输出重叠而被 GitHub 的 Secrets 保护丢弃。矩阵缺失时不会启动登录，最终汇总仍将缺失的账号报告计入失败。

企业微信使用普通**群机器人 Webhook**：在群内创建机器人，将完整地址放入 `notifications.wecom.webhook_url`。Telegram 使用 `notifications.telegram.bot_token` 和 `chat_id`。可配置任意一个、两个或都不配置。

消息超限时，**同一最终汇总**分段发送，不代表中途通知。企业微信按 2048 UTF-8 字节分段并限速；Telegram 保留 HTML 格式并按保守长度分段。发送失败不重复尝试，以免超时后重复推送；一个渠道失败不阻止另一个。

如果整个 JSON 无法解析，程序不会从不完整配置提取机器人密钥，也不会混用旧变量；此时可能只能通过 GitHub 任务失败状态和安全日志发现错误。

### 启用与验证

新模式有配置错误就失败，不与下面的旧变量混用。删除/清空 GitHub Secret `CHECKIN_CONFIG` 会重新使用旧模式，包括旧模式的免费代理/直连兜底。单个 Secret 最大 48 KiB；所有接收它的任务都能读取其中全部凭据，这不是互不信任任务之间的凭据隔离。不要提交配置到仓库，也不要在外部 PR 上运行带 Secrets 的任务。

依赖基线：Python 3.11、Playwright 1.64.1、Xray 26.1.23（按系统下载官方 ZIP 并核对固定 SHA-256），新旧模式使用同一内核。Windows/macOS Runner 的额度、计费和可用并发取决于仓库及 GitHub 套餐；版本化 Runner 标签不保证每次分配同一台电脑。

**内核版本与 TLS 风险：** 为兼容链接中明确配置的 `allowInsecure=1`，固定到仍支持该字段的 Xray 26.1.23；它不是最新版，后续版本已移除此字段。默认仍验证证书，不会自动开启不安全模式；显式关闭校验会失去服务端身份验证。较旧内核缺少后续修复，不应视为安全更新基线。子进程强制设置 `GODEBUG=multipathtcp=0` 以禁用旧内核涉及的 MPTCP 路径；不提供受已知 Hy2/gRPC 证书固定问题影响的 CA 固定配置。建议使用有效证书、删除不安全参数后再升级内核，而不是长期依赖该兼容版本。

先在 Actions 手动运行 **Credential-free platform smoke**，它只使用本地模拟网页、临时代理和虚构凭据验证三个系统，不会读取 Secrets。然后再运行 **Ayrouter Daily Check-in** 做实际签到。定时任务只使用仓库默认分支的工作流；开发分支上的改动需要按正常流程集成后才影响日常计划任务。

本地检查（Python 3.11 虚拟环境）：

```sh
python -m pip install requests playwright==1.64.1 pynacl pysocks
python -m unittest discover -s tests -v
python -m py_compile app.py routing.py proxy_runtime.py legacy_proxy.py report.py
bash -n setup-proxy.sh
python -m playwright install chromium
python tests/smoke.py
```

本地运行 `app.py` 会执行真实登录；新模式的本地账号必须全部匹配本机系统，多系统配置应通过 Actions 执行。`setup-proxy.sh` 通过 `legacy_proxy.py` 复用同一 Xray 下载、解析与启动逻辑，仍仅供旧 Linux/Actions 路径，不是 Windows 启动器。只保留选中节点的子进程；失败时仅停止自己启动的进程，不清理其他进程或占用端口。

## 旧变量兼容模式

下面的旧教程仅在未设置 `CHECKIN_CONFIG` 时适用；依旧使用单个 Ubuntu 任务。

## 🚀 快速开始

### 1. Fork 本仓库

点击右上角 **Fork** 按钮，将仓库复制到你的账号下。

### 2. 配置 Secrets

前往仓库的 **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加以下配置：

#### 必须配置（二选一）：

**方式一：多账号 / 多站点**

| Name | Value | 说明 |
|------|-------|------|
| `ACCOUNTS` | 多行文本 | 每行一个账号，格式 `[站点URL\|]邮箱:密码`，可配置任意多个账号、任意多个站点 |

> **示例**（Secret 值中直接换行）：
> ```
> https://agentrouter.org|user1@qq.com:Pass1234
> user2@gmail.com:Abcd5678
> https://example.com|user3@qq.com:Ab:cd
> ```
> - 站点前缀可省略，省略时默认 `https://agentrouter.org`
> - 站点与账号用 `\|` 分隔，密码中可包含冒号
> - 仅兼容 new-api 系站点（登录页与 AgentRouter 同款、有邮箱登录入口）
> - Telegram 通知中站点域名会打码（如 `agen***`），不会完整暴露

**方式二：单账号**

| Name | Value | 说明 |
|------|-------|------|
| `USERNAME` | 你的邮箱 | AgentRouter 登录邮箱 |
| `PASSWORD` | 你的密码 | AgentRouter 登录密码 |

#### 代理配置（可选，二选一或都不配）：

| Name | Value | 说明 |
|------|-------|------|
| `NODE_LINK` | 单节点链接或订阅 URL | 优先使用的自有干净节点（vmess/vless/trojan/hysteria2/socks5） |
| `PROXY_CONFIG_URL` | 订阅地址 URL | `NODE_LINK` 为空时的备用订阅地址 |

> **代理工作逻辑**：
> 1. **通道一（优先）**：配置了 `NODE_LINK` / `PROXY_CONFIG_URL` 时，脚本通过 [Xray](https://github.com/XTLS/Xray-core) 启动自有节点，直接登录
> 2. **通道二（兜底）**：自有节点未配置或登录失败时，自动从 [freeproxy](https://github.com/CharlesPikachu/freeproxy) 代理池随机抽取 100 个 IP，50 线程并发访问登录页检测是否触发阿里云 WAF；凑够 3 个干净 IP 或扫满 5 轮（500 个）为止
> 3. 日志中会对使用的代理 IP 打码（如 `124.248.***.***:1080`）
---
#### Telegram 通知（可选）：

| Name | Value | 说明 |
|------|-------|------|
| `TG_BOT_TOKEN` | Bot Token | 从 [@BotFather](https://t.me/BotFather) 获取 |
| `TG_CHAT_ID` | Chat ID | 你的 Telegram Chat ID |

### 3. 启用 GitHub Actions

1. 前往仓库的 **Actions** 标签页
2. 点击 **I understand my workflows, go ahead and enable them**
3. 脚本将在每天北京时间 06:45 自动运行

### 4. 手动测试运行

前往 **Actions** → 选择 **Ayrouter Daily Check-in** → 点击 **Run workflow**

## 📋 工作原理

1. **登录即签到**：AgentRouter 及同类 new-api 站点的签到机制是"登录即完成签到"
2. **浏览器自动化**：使用 Playwright 模拟真实浏览器登录
3. **多账号 / 多站点循环**：多个账号逐个顺序签到，单个账号失败不影响其他账号；任一失败时 Actions 退出码为 1
4. **双通道代理**：优先自有节点；未配置或失败时从免费代理池并发探测无 WAF 干净 IP 兜底（探测结果按站点共享轮换使用）
5. **每日自动运行**：GitHub Actions 定时任务

## ⚠️ 关于 WAF 验证

AgentRouter 使用了阿里云 WAF，在以下情况会触发滑块验证：
- GitHub Actions 等云服务 IP
- 数据中心 IP
- 频繁请求的 IP

**解决方案**：
1. ✅ **推荐**：配置自有干净节点（`NODE_LINK`），稳定可靠
2. ✅ **兜底**：免费代理池多轮抽样探测（成功率取决于池子质量）

## 🛠️ 常见问题

### Q: 如何获取 Telegram Chat ID？
A:
1. 向 [@userinfobot](https://t.me/userinfobot) 发送任意消息
2. Bot 会返回你的 Chat ID

### Q: 脚本运行失败怎么办？
A:
1. 查看 Actions 运行日志
2. 检查是否配置了代理
3. 确认账号密码是否正确
### Q: 其他平台授权登陆如何获取账号密码？
1.授权登入后 进入[个人主页](https://agentrouter.org/console/personal)

2.按照图片指示绑定邮箱

3.退出登陆 再通过邮箱登陆 第一次登陆的时候需要选择忘记密码 然后通过邮箱来重置密码

4.确认重置之后 会发邮件到指定的邮箱里面 里面会包含重置后的密码 拿到重置后的密码和邮箱 按照教程填写即可
<img width="2276" height="1415" alt="cac64968dbc60bfa3a90f288da42b6e9" src="https://github.com/user-attachments/assets/eb0d7d10-ecfa-468e-9905-b18eb34594d3" />

<img width="2263" height="1415" alt="image" src="https://github.com/user-attachments/assets/69db98ab-045c-458f-a4b0-8323310ffa64" />

<img width="2263" height="1415" alt="cff6a3d85c2f200756706920940474ba" src="https://github.com/user-attachments/assets/42860695-2306-4df2-b87d-614c979b690d" />

<img width="2263" height="1415" alt="3d64114db0c8512b25afe0230a969a2c" src="https://github.com/user-attachments/assets/85d92b3f-b06c-4236-9d5b-cbd04331ed14" />


## 📜 更新日志

- **2026-08-30**: 支持多站点（`ACCOUNTS` 行可带站点前缀，仅限 new-api 系站点），代理池按站点独立探测
- **2026-08-30**: 支持多账号（`ACCOUNTS` 多行配置），逐账号签到 + 汇总通知
- **2026-08-29**: 新增免费代理池兜底通道（并发 WAF 探测、多轮抽样、IP 日志打码）
- **2026-08-07**: 添加代理支持，绕过 WAF 验证
- **2026-08-07**: 改为账号密码登录模式
- **2026-08-06**: 初始版本

## 🙏 致谢

- [CharlesPikachu/freeproxy](https://github.com/CharlesPikachu/freeproxy) —— 感谢作者提供的免费代理池服务，本脚本的兜底代理通道基于该项目公开的代理数据

## 📄 许可证

MIT License
