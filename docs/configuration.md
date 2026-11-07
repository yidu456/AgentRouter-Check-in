# CHECKIN_CONFIG 详细配置手册

本手册对应 `dev-plus` 当前解析器。配置字段以 `routing.py` 为准，节点链接以 `proxy_runtime.py` 为准；Xray 内核本身支持的全部功能，不等于本项目都支持。

本文所有邮箱、密码、节点地址、UUID、机器人密钥和公钥均为虚构示例。**示例可通过配置解析，不代表能连接节点、登录或发送消息。** 使用时从自己的客户端复制完整节点信息，替换所有示例凭据，不能使用截断后的脱敏 UUID。

## 1. 配置放在哪里

在 GitHub 仓库的 **Settings → Secrets and variables → Actions → New repository secret** 创建：

| 项目 | 填写内容 |
| --- | --- |
| Secret 名称 | `CHECKIN_CONFIG`，名称不能改 |
| Secret 内容 | 一个完整 JSON 对象，不要添加外层引号、Markdown 代码围栏或注释 |
| 放置位置 | Secrets，不是公开的仓库 Variables，不是仓库内的配置文件 |
| 适用模式 | 新模式：账号、系统、代理列表、基本浏览器配置和通知全部由该变量确定 |

设置了非空 `CHECKIN_CONFIG` 后，账号不再从 `ACCOUNTS`、`USERNAME`、`PASSWORD` 等旧变量补全。配置不完整就失败，不会混用旧变量。

清空/删除这个 Secret 会回到旧模式；旧模式有免费代理及应用层直连兜底。**需要严格使用账号自有代理时，不要通过清空 Secret 来处理错误。**

### JSON 的通用限制

- 必须是标准 JSON：字符串用双引号，无注释、无末尾逗号、无 `NaN`/`Infinity`。
- 整个配置的 UTF-8 大小不超过 **48 KiB（49152 字节）**。
- 同一个对象不能重复写同名键；不能添加下文未支持的字段。
- 缺省值通过省略字段获得；不要用 `null`、空字符串或错误类型代替省略。
- 布尔值、数字、字符串不是同一种类型。例如 `1`、`"1"`、`true` 不可随意替换。
- 最多生成 256 个账号组；每组最多 3 个账号。全部账号展开后的代理候选总数不超过 47456（`{"random": 2}` 按两个候选计数），实际通常先受到 Secret 大小限制。

## 2. 顶层字段：只支持四项

| 字段 | 类型 | 必填 | 可以填什么 / 默认值 | 示例 |
| --- | --- | --- | --- | --- |
| `version` | 整数 | 是 | 当前只能是整数 `1`，不能是 `"1"`、`1.0`、`true` | `"version": 1` |
| `accounts` | 对象数组 | 是 | 至少一个完整账号对象，不能为 `[]` | 见第 3 节和完整场景示例 |
| `subscription_url` | 字符串 | 有 `node` 或 `random` 时必填 | 有效 HTTPS 订阅地址；仅使用 `link` 时可省略 | `"https://subscription.example.com/sub?format=links"` |
| `notifications` | 对象 | 否 | 省略或 `{}` 表示不配置通知；支持 `telegram`、`wecom` | 见第 6 节 |

不能在顶层添加 `proxy`、`browser`、`xray`、`runner`、`retry`、`user_agent` 等字段。也不能把 Xray 的 `inbounds/outbounds/routing` JSON 当作本项目配置。

`subscription_url` 不能有前后空白、URL 用户名/密码或 `#片段`；若带端口必须为 1～65535。它是取节点列表的来源，不是默认代理：每个账号仍必须明确写自己的 `proxies`。

## 3. 每个账号可以填写的字段

| 字段 | 类型 | 必填 | 允许值 / 默认值 | 示例 |
| --- | --- | --- | --- | --- |
| `id` | 字符串 | 是 | 全局唯一；以英文字母开头，其后可用英文字母、数字、`_`、`-`，总长度 1～32 | `"account_mac_01"` |
| `username` | 字符串 | 是 | 非空且不能只有空白；通常填写登录邮箱，原样保留 | `"user1@example.com"` |
| `password` | 字符串 | 是 | 非空字符串，原样保留冒号、竖线及前后空格 | `"example:secret|value"` |
| `os` | 字符串 | 是 | 只能是 `"ubuntu"`、`"windows"`、`"macos"` | `"macos"` |
| `proxies` | 对象数组 | 是 | 至少一个候选，每个候选只能填写 `node`、`link`、`random` 中的一项 | 见第 4 节 |
| `site` | 字符串 | 否 | 默认 `"https://agentrouter.org"`；支持 HTTP/HTTPS 站点和可选路径前缀 | `"https://panel.example.com"` |
| `profile` | 对象 | 否 | 省略或 `{}` 使用默认基本浏览器配置 | 见第 5 节 |

### ID、站点与重复账号

- `id` 会出现在安全清单、报告、日志和通知里，不要把邮箱、密码、订阅密钥作为 ID。
- ID 区分大小写，例如 `a01` 和 `A01` 是不同 ID；建议保持统一命名，避免误配置同一账号。
- 同一个规范化站点和同一个原样用户名的组合不能重复登记，不可把同一账号分别配置为三个系统。
- `site` 不带协议时自动补 `https://`，例如 `panel.example.com`。
- `site` 不能有前后空白、URL 用户名/密码、查询参数或 `#片段`。程序在站点地址后追加 `/login`，所以通常填写不带末尾斜线的站点根地址；它不是任意登录页 URL。
- 多站点必须兼容当前 AgentRouter/new-api 类登录表单与用户 API，填写任意网站并不会自动适配其登录流程。

### 系统值与真实 Runner

| `os` 中填写 | GitHub Runner 标签 | 原生浏览器 |
| --- | --- | --- |
| `ubuntu` | `ubuntu-24.04` | Linux Chromium |
| `windows` | `windows-2022` | Windows Chromium |
| `macos` | `macos-15`（ARM64） | macOS Chromium |

`os` 中不能填写 `macos-15`、`linux`、`MacOS` 等其他值。`macos-14` 已退役，不能继续用于当前工作流。

系统分组顺序固定为 Ubuntu → Windows → macOS，同系统账号按 ID 排序，每三个划为一组；不是按 `accounts` 数组顺序运行。每个账号内部的 `proxies` 顺序不会重排。系统和账号绑定是固定的，不会每天随机选择系统。

## 4. `proxies`：账号自己的 1～N 个候选

每个候选必须是只有一个键的对象：

| 字段 | 类型 | 含义 | 条件 |
| --- | --- | --- | --- |
| `link` | 非空字符串 | 完整节点分享链接，不是订阅地址 | 支持的协议见第 8 节；不能有前后空白 |
| `node` | 非空字符串 | 共用订阅中节点的名称 | 顶层必须有 `subscription_url`；名称不能有前后空白 |
| `random` | 正整数 | 从订阅随机分配几个候选 | 顶层必须有 `subscription_url`；允许 1～47456，还受全局展开候选上限和实际可用节点数限制；不接受布尔值、小数或字符串 |

合法的局部示例：

```json
{
  "proxies": [
    {"link": "socks5://primary.example.com:1080#primary"},
    {"link": "socks5://backup.example.com:1080#backup"}
  ]
}
```

也可以在同一账号中混用订阅引用和直接链接：

```json
{
  "proxies": [
    {"node": "mac-primary"},
    {"link": "trojan://example-secret@backup.example.com:443?sni=tls.example.com#mac-backup"}
  ]
}
```

第二个局部示例还需要顶层订阅地址和完整账号字段，不能单独作为 `CHECKIN_CONFIG` 使用。

### 尝试与隔离规则

1. 每次从第一个可尝试候选开始；配置错误/原生检查失败的候选不能用于登录。
2. 一次登录尝试使用该候选对应的本地代理端口；失败后关闭浏览器，再尝试下一个。
3. 首次成功立即停止，不会为了遍历所有节点再次登录。
4. 全部失败只影响该账号，不借用其他账号的候选，不用免费代理，不直连。
5. `attemptN` 是传给登录控制器的候选列表序号；前期被过滤的节点会另外显示配置错误，它不是保证与原 JSON 下标一致的节点名称。

同一 `node` 名称或同一直接链接身份不能重复出现在同一配置的任何账号中。直接链接的 `#备注` 不参与身份比较；只改备注不算换节点。

这些检查不能保证实际出口 IP 不重复，也不能可靠识别“同一真实节点分别以 `node` 和 `link` 引用”等所有情况；请自行确保账号绑定了所需的独立节点和出口。

### 随机候选：不依赖订阅中的名称

```json
{
  "proxies": [
    {"link": "socks5://fixed.example.com:1080#fixed-first"},
    {"random": 2}
  ]
}
```

该局部示例需要完整账号字段和顶层 `subscription_url`。先尝试固定节点，再按本轮分配顺序尝试最多两个随机候选；首次登录成功就停止。多个 `random` 项可混用，计数相加，展开位置保留。

- `prepare` 获取订阅并生成本轮随机种子及带密钥的池指纹；每个 worker 再取一次实际订阅，验证一致后按全局账号 ID 顺序重建同一分配。不是各系统各自随便抽取。
- 先移除全配置所有 `link` / `node` 固定绑定；随机池按校验后的节点配置去重，全账号、全部系统、全部分组之间不重复分配候选，即使其中某个候选没有被实际使用，也不借给其他账号。
- 纯随机配置允许没有名称、重名、改名或订阅排序变化。无效/不支持的节点会被跳过；只从本项目可转换为 Xray 的有效节点中抽取。订阅仍必须是明文/base64/base64url 链接列表，**不支持把 Clash YAML / sing-box JSON 当随机池**。
- 混有 `node` 时仍按严格名称规则解析；重名订阅、固定名称消失、两个固定绑定解析为同一配置、无法校验固定绑定、候选不足，都安全失败，不能忽略固定绑定继续抽取。
- 准备后实际有效节点池或完整配置发生变化，worker 报 `RANDOM_POOL_FAIL`，不登录、不重抽、不共享节点、不回退直连。新运行才重新抽取。固定名称配置改变即使仅是改名，也不能像纯随机配置那样忽略。
- 随机订阅响应最大 4 MiB，网络请求设置超时。准备清单仅新增种子和带密钥的指纹，不包含节点名、地址、链接、认证或 Xray 配置。指纹是完整性绑定，不是节点加密。
- 去重和隔离基于可识别的有效节点配置，不保证不同节点有不同出口 IP，也不保证新运行必然抽到不同节点。

完整三系统示例（至少需要六个互不重复的有效随机节点）：

```json
{
  "version": 1,
  "subscription_url": "https://subscription.example.com/sub?format=links",
  "notifications": {
    "wecom": {"webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"}
  },
  "accounts": [
    {"id": "random_ubuntu", "username": "one@example.com", "password": "example-one", "os": "ubuntu", "proxies": [{"random": 2}]},
    {"id": "random_mac", "username": "two@example.com", "password": "example-two", "os": "macos", "proxies": [{"random": 2}]},
    {"id": "random_windows", "username": "three@example.com", "password": "example-three", "os": "windows", "proxies": [{"random": 2}]}
  ]
}
```

## 5. `profile`：可固定的基本浏览器配置

只支持以下六项，不支持 `user_agent`、`platform`、`browser_version`、Canvas/WebGL、字体、硬件指纹等附加字段。

| 字段 | 类型 | 允许值 | 不填写时 |
| --- | --- | --- | --- |
| `viewport` | 对象 | 只能含整数 `width`、`height`，两者范围均为 320～8192 | 1440 × 900 |
| `screen` | 对象 | 同上；宽高分别不能小于 `viewport` | 若填写了 `viewport`，跟随它；否则 1440 × 900 |
| `device_scale_factor` | 整数 | `1` 或 `2`，不能是字符串/小数/布尔值 | `1` |
| `locale` | 字符串 | `zh-CN`、`en-US` | `zh-CN` |
| `timezone_id` | 字符串 | `Asia/Shanghai`、`Asia/Tokyo`、`America/New_York`、`Europe/London` | `Asia/Shanghai` |
| `color_scheme` | 字符串 | `light`、`dark` | `light` |

下面是默认值的完整表示：

```json
{
  "viewport": {"width": 1440, "height": 900},
  "screen": {"width": 1440, "height": 900},
  "device_scale_factor": 1,
  "locale": "zh-CN",
  "timezone_id": "Asia/Shanghai",
  "color_scheme": "light"
}
```

固定英文、伦敦时区、深色和较大屏幕的局部示例：

```json
{
  "profile": {
    "viewport": {"width": 1280, "height": 720},
    "screen": {"width": 1920, "height": 1080},
    "device_scale_factor": 2,
    "locale": "en-US",
    "timezone_id": "Europe/London",
    "color_scheme": "dark"
  }
}
```

例如只写 `"profile": {"viewport": {"width": 1280, "height": 720}}`，屏幕也会自动设为 1280 × 720，而不是保留默认 1440 × 900。

需要真实 macOS Chrome 系浏览器环境时填写 `"os": "macos"`；当前安装的是 Playwright Chromium，不是自行下载安装的 Google Chrome stable。程序使用原生系统的默认 UA，不在 Ubuntu 上通过伪造 UA 冒充 macOS。固定这些属性不代表完整硬件指纹固定，也不保证账号不可关联。

## 6. `notifications`：Telegram / 企业微信群机器人

| 完整路径 | 类型 | 允许值 / 要求 |
| --- | --- | --- |
| `notifications` | 对象 | 可省略或为 `{}`；只能包含 `telegram`、`wecom` |
| `notifications.telegram` | 对象 | 若出现，必须同时且仅包含下列两项 |
| `notifications.telegram.bot_token` | 非空字符串 | 自己的 Telegram Bot Token；不要填示例值 |
| `notifications.telegram.chat_id` | 非空字符串 | 私聊/群聊/频道 ID 字符串，例如 `"123456789"`、`"-1001234567890"`，不能写成 JSON 数字 |
| `notifications.wecom` | 对象 | 若出现，必须且仅包含 `webhook_url` |
| `notifications.wecom.webhook_url` | 字符串 | 正确的企业微信群机器人 HTTPS Webhook，规则见下文 |

两个渠道同时配置：

```json
{
  "notifications": {
    "telegram": {
      "bot_token": "example-token",
      "chat_id": "-1001234567890"
    },
    "wecom": {
      "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"
    }
  }
}
```

只需要一个渠道就删掉另一个对象；都不需要就省略 `notifications` 或写 `{}`。不要写 `"telegram": {}`、`"wecom": null` 来表示关闭。

企业微信 URL 必须符合：

- HTTPS，域名为 `qyapi.weixin.qq.com`，端口省略或 443。
- 路径必须为 `/cgi-bin/webhook/send`。
- 查询参数只能有一个非空 `key`，不能重复 `key` 或添加其他参数。
- 不能有前后空白、URL 用户名/密码或 `#片段`。

普通群机器人不需要 `corp_id`、`agent_id`、`corp_secret`，当前配置不支持这些字段。

所有分组结束后才发送最终汇总；日志不是机器人中途通知。缺失/损坏报告计失败。消息超长会把同一汇总分段：企业微信每段不超过 2048 UTF-8 字节并限速；一个渠道失败不阻止另一个，发送失败不自动重试，避免重复发送。配置合法只说明字段通过检查，不代表机器人密钥、权限或目标 Chat ID 实际可用。

整个 JSON 本身非法时，程序不会从坏配置中提取通知密钥，也不混用旧通知变量；这时可能只有 Actions 失败状态和安全日志，没有机器人汇总。

## 7. 完整场景示例

### 7.1 最小配置：Ubuntu，一个账号，一个 SOCKS5 节点，无通知

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "ubuntu01",
      "username": "user1@example.com",
      "password": "example-secret",
      "os": "ubuntu",
      "proxies": [{"link": "socks5://proxy.example.com:1080#ubuntu-only"}]
    }
  ]
}
```

省略站点和 profile 使用默认值。没有订阅引用，所以无需 `subscription_url`。

### 7.2 VLESS + WebSocket + TLS + Early Data，企业微信通知

```json
{
  "version": 1,
  "notifications": {
    "wecom": {
      "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"
    }
  },
  "accounts": [
    {
      "id": "vless01",
      "site": "https://agentrouter.org",
      "username": "user2@example.com",
      "password": "example-secret-two",
      "os": "macos",
      "proxies": [
        {"link": "vless://11111111-1111-4111-8111-111111111111@node.example.com:443?encryption=none&security=tls&type=ws&host=front.example.com&sni=tls.example.com&path=%2F%3Fed%3D2048%26marker%3Ddummy&ed=2048&eh=Sec-WebSocket-Protocol#mac-ws"}
      ],
      "profile": {
        "viewport": {"width": 1440, "height": 900},
        "screen": {"width": 1440, "height": 900},
        "device_scale_factor": 1,
        "locale": "zh-CN",
        "timezone_id": "Asia/Shanghai",
        "color_scheme": "light"
      }
    }
  ]
}
```

本例默认验证节点 TLS 证书；不要为了消除错误自动加 `allowInsecure=1`。链接中的 `node.example.com` 是实际连接地址，`host` 是 WS Host，`sni` 是 TLS 服务端名称，三者不是同一个字段的不同写法。

### 7.3 三系统、Ubuntu 账号两个候选、两个通知渠道

```json
{
  "version": 1,
  "notifications": {
    "telegram": {"bot_token": "example-token", "chat_id": "123456789"},
    "wecom": {"webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"}
  },
  "accounts": [
    {
      "id": "ubuntu01",
      "username": "ubuntu-user@example.com",
      "password": "example:secret|ubuntu",
      "os": "ubuntu",
      "proxies": [
        {"link": "vless://11111111-1111-4111-8111-111111111111@ubuntu-primary.example.com:443?encryption=none&security=tls&type=ws&host=front.example.com&path=%2Fsocket#ubuntu-primary"},
        {"link": "trojan://example-secret@ubuntu-backup.example.com:443?sni=tls.example.com#ubuntu-backup"}
      ]
    },
    {
      "id": "mac01",
      "username": "mac-user@example.com",
      "password": "example-secret-mac",
      "os": "macos",
      "proxies": [{"link": "socks5://example-user:example-password@mac-proxy.example.com:1080#mac-only"}],
      "profile": {"locale": "zh-CN", "timezone_id": "Asia/Tokyo", "device_scale_factor": 2}
    },
    {
      "id": "windows01",
      "username": "windows-user@example.com",
      "password": "example-secret-windows",
      "os": "windows",
      "proxies": [{"link": "hy2://example-auth@windows-proxy.example.com:443?sni=tls.example.com&obfs=salamander&obfs-password=example-obfs#windows-only"}],
      "profile": {
        "viewport": {"width": 1280, "height": 720},
        "screen": {"width": 1920, "height": 1080},
        "locale": "en-US",
        "timezone_id": "Europe/London",
        "color_scheme": "dark"
      }
    }
  ]
}
```

本例会生成三个组：Ubuntu → Windows → macOS。Ubuntu 第一个候选成功就不会使用第二个；它失败也不会借用 macOS/Windows 的节点。

### 7.4 共用订阅，账号按名称取节点，并保留直接链接备用

```json
{
  "version": 1,
  "subscription_url": "https://subscription.example.com/sub?format=links",
  "accounts": [
    {
      "id": "sub01",
      "username": "subscription-user1@example.com",
      "password": "example-secret-one",
      "os": "ubuntu",
      "proxies": [{"node": "ubuntu-primary"}, {"node": "ubuntu-backup"}]
    },
    {
      "id": "sub02",
      "username": "subscription-user2@example.com",
      "password": "example-secret-two",
      "os": "macos",
      "proxies": [
        {"node": "mac-primary"},
        {"link": "socks5://mac-backup.example.com:1080#mac-direct-backup"}
      ]
    }
  ]
}
```

订阅中需要有这些名称，例如明文响应：

```text
socks5://subscription-ubuntu1.example.com:1080#ubuntu-primary
socks5://subscription-ubuntu2.example.com:1080#ubuntu-backup
socks5://subscription-mac.example.com:1080#mac-primary
```

也支持整份链接列表的 base64/base64url 编码。非 VMess 节点名称来自 URL 解码后的 `#备注`；VMess 名称来自解码 JSON 中的 `ps`。未命名节点不会成为可引用条目；订阅中重名节点会导致来源失败。

**不支持 Clash YAML 或 sing-box/Xray 完整 JSON 订阅。** 订阅地址中的 `target=singbox`、`target=clash` 等文字并不能证明响应兼容；要看服务实际返回的是不是节点 URI 列表。请在服务端选择该服务支持的“分享链接列表/base64 链接列表”格式，不要凭空套用通用 `target` 参数。

## 8. 节点链接支持的字段与完整示例

所有协议都需要有效节点服务器地址和 1～65535 端口。节点 URI 的外层查询参数不允许重复同名键，不支持的参数会失败，而不是偷偷忽略；WS 路径内部的查询规则另见 `ed` 说明。特殊字符必须按 URL 编码；`#备注` 是可选名称，不是鉴权信息。

### 8.1 VLESS

形式：`vless://完整UUID@服务器:端口?参数#备注`。

| 参数 | 允许值 / 含义 |
| --- | --- |
| UUID（`@` 前） | 完整可解析 UUID，推荐标准 36 字符形式；不能是客户端展示的脱敏截断值 |
| `encryption` | 省略或 `none`；不支持其他 VLESS encryption 模式 |
| `security` | 省略/`none`、`tls`、`reality`；普通公网使用建议启用 TLS 或 Reality |
| `type` | 省略/`tcp`/`none` 为 TCP；`ws` 为 WebSocket；`grpc`/`gun` 为 gRPC |
| `flow` | 省略/空，或 `xtls-rprx-vision`；Vision 只允许 TCP + TLS/Reality |
| `sni` / `serverName` | TLS/Reality 服务端名称；省略时使用连接服务器名称。两个别名选一个 |
| `insecure` / `allowInsecure` | `0`、`1`、`false`、`true`；TLS 默认关闭不安全模式。不要同时填写两个别名 |
| `host` | 只用于 WS Host；TCP/gRPC 不能附带这个参数 |
| `path` | 只用于 WS，解码后必须以 `/` 开始，无 URL 协议/主机/片段；省略时使用 `/` |
| `serviceName` / `service_name` | gRPC 必须配置非空服务名；TCP/WS 不能附带它 |
| `ed` | 只用于 WS；ASCII 十进制整数 0～4294967295，`0` 关闭 Early Data |
| `eh` | 只用于 WS，支持 `Sec-WebSocket-Protocol`（头名称大小写不敏感）；省略使用 Xray 固定机制 |
| `pbk` / `publicKey` | Reality 公钥，必须与服务端匹配；普通 TLS/无 TLS 不支持此字段 |
| `sid` / `shortId` | Reality short ID，必须为 2～16 个十六进制字符，长度为偶数，不能省略/空 |
| `fp` | 仅 Reality：`chrome`、`firefox`、`edge`、`safari`、`360`、`qq`、`ios`、`android`、`random`、`randomized`；默认 `chrome` |

重要组合限制：

- 无 TLS 时不能附带 `sni`、`serverName`、`insecure`、`allowInsecure` 等 TLS 参数，即使填写的是 `allowInsecure=0`。
- Reality 不支持 WS，也不允许启用不安全证书开关；显式 `0`/`false` 可接受，`1`/`true` 会失败。当前可用组合为 TCP/gRPC，Vision 则只允许 TCP。
- 普通 TLS 的 `fp=chrome` 当前也不在解析器支持范围内；不要把其他客户端的所有扩展参数直接照搬。
- WS 路径中的 `ed` 也会被识别。如果外层 `ed` 和路径内 `ed` 同时存在，数值必须一致；路径内不能有两个 `ed`。其他重复查询键可以保留。
- `eh=` 空值仅在有效 Early Data 数量为 0 时允许；启用 Early Data 不能指定空头或 `X-Early-Data` 等自定义头。
- Xray 从路径 `ed` 参数读取 Early Data 设置，使用固定协议头传输；该设置不代表服务端收到的请求路径必须保留 `ed` 参数。

TCP + TLS：

```text
vless://11111111-1111-4111-8111-111111111111@node.example.com:443?encryption=none&security=tls&type=tcp&sni=tls.example.com#vless-tcp
```

WS + TLS + Early Data，默认验证证书：

```text
vless://11111111-1111-4111-8111-111111111111@node.example.com:443?encryption=none&security=tls&type=ws&host=front.example.com&sni=tls.example.com&path=%2Fsocket%3Fmarker%3Ddummy&ed=2048&eh=Sec-WebSocket-Protocol#vless-ws
```

gRPC + TLS：

```text
vless://11111111-1111-4111-8111-111111111111@node.example.com:443?encryption=none&security=tls&type=grpc&serviceName=example-service&sni=tls.example.com#vless-grpc
```

TCP + Reality + Vision；下列公钥和 short ID 仅为格式示例，不能用于真实节点：

```text
vless://11111111-1111-4111-8111-111111111111@node.example.com:443?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&sni=tls.example.com&fp=chrome&pbk=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&sid=0123456789abcdef#vless-reality
```

### 8.2 VMess

形式：`vmess://base64编码的JSON`，不是把 UUID 直接放在 `@` 前。

| 解码 JSON 字段 | 允许值 / 含义 |
| --- | --- |
| `add` | 必填，节点服务器地址 |
| `port` | 必填，1～65535 的整数或 ASCII 数字字符串 |
| `id` | 必填，完整有效 UUID |
| `v` | 可选元信息，建议 `"2"` |
| `ps` | 可选备注；订阅按名称引用时需要非空名称 |
| `aid` | 省略默认 0；请使用 `0` 或 `"0"`，非零整数不支持 |
| `net` | 省略/`tcp`/`none`、`ws`、`grpc`/`gun` |
| `tls` | 省略/空/`none` 不启用 TLS；`tls` 启用 TLS |
| `sni` / `serverName` | TLS SNI，省略时跟随 `add`；没有 TLS 时不能填写 |
| `allowInsecure` | TLS 下接受布尔值、整数 0/1、字符串 `0`/`1`/`false`/`true`；没有 TLS 时不能填写 |
| `host` / `path` | WS Host 和路径，不能用作 TCP/gRPC 的字段 |
| `serviceName` / `service_name` | gRPC 非空服务名，TCP/WS 不能填写 |
| `scy` | 省略/空/`auto`；不支持手动指定其他加密算法 |
| `type` | 省略/空/`none`；不支持 HTTP 等头部伪装 |

VMess 不接受额外 `fp`、`ed`、`eh` JSON 字段；WS Early Data 可通过支持的路径 `ed` 查询设置。不要给 VMess 链接末尾再拼 `#备注`，使用 `ps`。

解码后的完整示例：

```json
{
  "v": "2",
  "ps": "vmess-example",
  "add": "node.example.com",
  "port": "443",
  "id": "22222222-2222-4222-8222-222222222222",
  "aid": "0",
  "net": "ws",
  "type": "none",
  "host": "front.example.com",
  "path": "/socket?marker=dummy",
  "tls": "tls",
  "sni": "tls.example.com",
  "scy": "auto"
}
```

把上述对象存入一个**只有虚构数据**的 `vmess-example.json` 后，可在本地生成完整分享链接：

```python
import base64
import json
from pathlib import Path

payload = json.loads(Path("vmess-example.json").read_text(encoding="utf-8"))
encoded = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
print("vmess://" + encoded)
```

真实节点直接从客户端复制完整链接即可；不要把包含真实 UUID 的生成结果、文件或控制台输出发到公开渠道。

### 8.3 Trojan

形式：`trojan://URL编码后的密码@服务器:端口?参数#备注`。默认使用 TLS。

| 参数 | 允许值 |
| --- | --- |
| 密码（`@` 前） | 必填，非空；特殊字符先 URL 编码，不要明文拼接 `:`/`@`/`#` |
| `security` | 省略或 `tls`，不支持 `none`/`reality` |
| `sni` / `serverName` | TLS SNI，省略时为连接服务器名称 |
| `insecure` / `allowInsecure` | `0`、`1`、`false`、`true`，默认验证证书 |
| `type` | TCP、WS、gRPC 的允许值与 VLESS 相同 |
| `host` / `path` | 仅 WS |
| `serviceName` / `service_name` | 仅 gRPC，必须非空 |

不支持 Trojan 的 `fp`、`ed`、`eh`、`flow` 等额外查询参数；WS 路径仍按共用的 WS 规则处理。

```text
trojan://example-secret@node.example.com:443?type=ws&sni=tls.example.com&host=front.example.com&path=%2Fsocket#trojan-ws
```

密码含 `:` 和 `@` 的格式示例：

```text
trojan://example%3Asecret%40value@node.example.com:443?sni=tls.example.com#trojan-encoded-password
```

### 8.4 Hysteria2 / Hy2

`hysteria2://` 与 `hy2://` 使用同一解析器。默认 TLS，不需要指定 WS/TCP/gRPC 类型。

| 参数 | 允许值 |
| --- | --- |
| 鉴权密码（`@` 前） | 必填非空，特殊字符使用 URL 编码 |
| `security` | 省略或 `tls` |
| `sni` / `serverName` | TLS SNI，省略时为连接服务器名称 |
| `insecure` / `allowInsecure` | `0`、`1`、`false`、`true`，默认验证证书 |
| `obfs` | 省略/空为无混淆；仅支持 `salamander` |
| `obfs-password` / `obfs_password` | `obfs=salamander` 时必填，至少 4 个 UTF-8 字节，别名选一个 |

没有 `obfs=salamander` 时不能单独填混淆密码。`auth`、`upmbps`、`downmbps`、`mport`、`type` 等其他客户端扩展字段当前不支持；这不是任意 Hy2 客户端配置导入器。

```text
hy2://example-auth@node.example.com:443?sni=tls.example.com&obfs=salamander&obfs-password=example-obfs#hy2-example
```

四个 ASCII 字符恰好为 4 字节；其他字符按 UTF-8 字节数计算，不是简单按字符数量判断。这里的最小长度只是内核兼容要求，不是推荐的安全密码长度。

### 8.5 SOCKS5 / SOCKS

两种协议前缀都按 SOCKS5 处理，无查询参数：

```text
socks5://node.example.com:1080#socks-no-auth
socks://example-user:example-password@node.example.com:1080#socks-auth
socks5://example-user:example%3Asecret%40value@node.example.com:1080#socks-encoded-password
```

可以不填鉴权；填写用户名时必须同时带密码位置，即 `user:password@`，不能写成 `user@`。用户名非空，空密码位置可以存在，但服务器是否允许取决于其配置。不能添加 `?username=...`、`?password=...` 等查询参数，也不支持把 `http://proxy...` 当作 `link`。

## 9. 特殊字符、类型和不合法写法

账号密码在 JSON 中按 JSON 转义，不按 URL 编码。下面对象中的密码解码后包含冒号、竖线、双引号和反斜杠：

```json
{
  "password": "example:secret|with\"quote\\slash"
}
```

节点链接中的鉴权部分和查询值则按 URL 编码，例如：`:` → `%3A`，`@` → `%40`，`#` → `%23`，`&` → `%26`，`+` → `%2B`。URL 查询中未编码的 `+` 会被按空格处理；不要对已经编码好的客户端链接盲目重复编码。

| 不合法写法 | 原因 / 正确方式 |
| --- | --- |
| `"version": "1"` | 必须为整数 `1` |
| `"accounts": []` | 必须至少有一个账号 |
| `"os": "macos-15"` | 填 `"macos"`，Runner 标签由程序生成 |
| `"id": "01user"` | ID 必须以英文字母开头 |
| `"proxies": []` | 至少一个候选 |
| 一个候选同时写 `node`、`link` 或 `random` | 每个对象只能有一个键；拆成不同候选 |
| 有 `node` / `random` 但无订阅地址 | 填顶层 `subscription_url`，或改用完整 `link` |
| `"profile": null` | 省略，或填写 `{}` |
| `"device_scale_factor": 1.5` | 仅允许整数 1/2 |
| 屏幕小于视口、`viewport` 少了高度 | 宽高均必填，且屏幕各维不小于视口 |
| `"locale": "ja-JP"` | 当前只允许 `zh-CN`/`en-US`，时区东京不代表语言支持日语 |
| `"color_scheme": "auto"` | 仅 `light`/`dark` |
| `"user_agent": "macOS Chrome"` | 顶层和 profile 均不支持此字段；选择真实 `os` |
| 把订阅 URL 填入 `link` | `link` 必须是节点 URI；订阅地址放顶层 |
| 链接里的 UUID 只有半截 | 换成完整客户端分享链接，不从其他密钥猜测/拼接 |
| 内核支持某参数，故直接添加到链接 | 本项目有明确的解析器白名单，未知参数会失败 |

## 10. 常见状态码怎么读

配置解析、节点检查、网络访问、网页登录是不同阶段，不能看到失败就统一判断“代理不支持”。

| 状态码 / 日志码 | 含义与检查方向 |
| --- | --- |
| `ROUTE_CONFIG_FAIL` / `SCRIPT_FAIL` | 配置类型、字段、重复绑定、系统/任务分配等失败；先查字段表 |
| `NODE_SOURCE_FAIL` | 订阅读取/解码/重名/内容格式失败；不要公开订阅 URL |
| `NODE_MISSING` | 订阅没有所引用名称，或对应节点未成为可用条目 |
| `NODE_CONFIG_FAIL` | 节点 URI 字段、UUID、协议组合或参数不受支持 |
| `BINARY_DOWNLOAD_FAIL` | 内核下载、哈希、平台或 ZIP 检查失败；控制器可能汇总为启动失败 |
| `PROXY_START_FAIL` | 无可用原生配置、端口冲突、内核检查/启动/就绪失败等 |
| `BROWSER_LAUNCH_FAIL` | Chromium 启动失败，不等同于节点不可用 |
| `NODE_UNREACHABLE` + `NAVIGATION_FAIL` | 通过所选节点导航失败；看安全的 Chromium 错误码，区分连接、域名或 TLS 等方向 |
| `GOTO_TIMEOUT` / `PAGE_TIMEOUT` | 页面导航重试仍超时或后续网页操作超时 |
| `WAF_TIMEOUT` | WAF/页面就绪启发式检查超时，不足以认定一定被 WAF 拦截；程序不保证绕过网站风控 |
| `FORM_NOT_FOUND` / `FORM_OPERATE_TIMEOUT` | 无适配入口/表单/输入或提交控件，或表单操作阶段超时；见下节 |
| `USER_API_FAIL` / `API_PAYLOAD_FAIL` | 登录后用户 API 失败或数据结构不符，不能仅凭此码断定账号密码错误 |
| `QUOTA_INVALID` | 余额不是 0～9223372036854775807 的整数（布尔值不算整数），或接口格式不符 |
| `RANDOM_POOL_FAIL` | 随机池无法读取/校验、候选不足、固定绑定冲突或本轮配置/有效池不一致；不会启动登录 |
| `PROXY_LIST_EXHAUSTED` | 没有可尝试候选；旧版本也用它覆盖所有登录失败，需新建当前分支运行取得详细阶段 |
| `UNEXPECTED` / `UNKNOWN` | 未分类异常/未知阶段；不输出可能含凭据的原始异常 |
| `UNFINISHED` / `JOB_MISSING` | 账号未完成或预期任务缺报告，例如超时/取消 |
| `REPORT_INVALID` / `PREPARE_FAIL` | 报告无效或准备任务失败；最终汇总不会将其算成功 |
| `NO_PROXY` | 旧模式无可用代理；不是新模式允许直连的标志 |
| `SUCCESS` | 登录结果包含通过检查的余额；配置信息中不能手工填写此码 |

失败候选的示例日志（只展示格式，不代表你的真实原因）：

```text
NAVIGATION_FAIL: ERR_TUNNEL_CONNECTION_FAILED
mac01 attempt1: NODE_UNREACHABLE
mac01 attempt2: WAF_TIMEOUT
mac01: WAF_TIMEOUT
```

最终报告保留最后一次失败阶段，同时日志保留每次尝试的阶段。报告只保存一个最终阶段，不是全部候选历史；不要忽略前面的日志。打印网络码也不等于已经证明“节点服务器坏了”，故障还可能在节点出口、目标站、DNS 或 TLS 等链路位置。

### 10.1 `FORM_NOT_FOUND` 到底发生在哪一步

这个错误发生在脚本成功点击提交控件之前，不是服务端验证密码后的判定。**部分分支可能已经填入用户名或密码，不能据此保证输入框完全未填写。** 代码有五处返回同一个阶段：

| 触发位置 | 条件 |
| --- | --- |
| 切换邮箱/用户名方式 | 初步检查的可见输入框数量为 0，且特定邮箱入口无法被找到并成功点击 |
| 表单预检查 | 最多轮询约 15 秒后，仍不能同时找到可见的用户名框、密码框和 `button[type="submit"]` |
| 定位用户名框 | 预检查后实际用户名定位器找不到可见控件，例如页面发生变化 |
| 定位密码框 | 用户名已填写，但密码定位器找不到可见控件 |
| 定位提交控件 | 用户名和密码已填写，但提交定位器找不到可见控件，尚未点击提交 |

到达这些位置说明浏览器和导航没有在更早阶段直接返回失败，页面就绪启发式检查也已放行；不代表服务端认证成功。

2026-11-07 实际浏览公开登录页，确认中文入口为“使用 邮箱或用户名 登录”，旧版本没有匹配到它，且会因导航栏的普通“登录”误判就绪。当前版本已补上该入口，英文/中文匹配允许空白差异，就绪检查与点击共用同一组规则；可见性检查也避免把隐藏模板当作可填写表单。英文入口是 `Sign in with Email or Username`，切换后两个输入框分别为 `username`、`password`，实际提交按钮是 `type="submit"` 的“继续 / Continue”。这些是公开页面检查，不是一次真实账号登录。

其他网站仍可能有结构差异：表单预检查要求 `button[type="submit"]`，实际提交定位器还有其他选择器；因此只有普通按钮但无提交类型的第三方 UI 仍可能被预检查挡住。不要把本次兼容修复理解为支持任意网站。

可能原因包括新版前端/入口文案或选择器不匹配、页面尚未渲染完、邮箱密码登录被关闭、重定向到了其他页面，或拦截/错误页被误认为可登录页面。这个码不是“密码错误”或“代理坏了”的判定，也不能仅凭它确定是上述哪一处触发。

仅看此码不能确定 Runner 实际收到哪一种页面，也不能证明已真正通过 WAF 或目标站返回了成功状态。下一步需要核对**公开登录页的入口与表单**，或收集脱敏的页面阶段信息。不要为排查提供账号密码、节点链接、Cookie、localStorage 或含个人信息的截图。

## 11. 安全保存、验证和升级边界

1. 示例替换完后，只放进 GitHub Secret；不要把真实 JSON、节点链接、截图、机器人 Webhook 提交到仓库或公开讨论。
2. 所有收到这个完整 Secret 的任务都能读取全部账号与通知凭据；多系统/多进程不等于凭据互不信任隔离。
3. 核对完整 UUID、证书、Host/SNI/路径、订阅格式及每账号出口；不要通过取消校验、放宽字段或启用直连掩盖故障。
4. 本项目固定 Xray **26.1.23** 兼容明确配置的 `allowInsecure`；较新版本已移除此开关。默认仍验证证书，显式 `allowInsecure=1` 会失去服务端身份验证。
5. 该兼容内核不是最新安全基线。子进程强制禁用 MPTCP，并不代表所有后续修复都已包含；也不开放受已知 Hy2/gRPC CA 固定问题影响的 CA 固定字段。长期方案是配置有效证书、移除不安全选项后再升级内核。
6. 已公开过的真实密码、订阅令牌、节点凭据和机器人密钥应及时轮换，不要只删除聊天中的文本。

**离线字段检查不等于真实登录测试。** 已设置环境变量后，这条命令只校验外层字段，成功仅输出固定标记，不打印配置、不联网、不生成凭据文件：

```sh
python -c "import os; from routing import parse_config; parse_config(os.environ['CHECKIN_CONFIG']); print('CONFIG_VALID')"
```

`routing.py prepare` 生成安全清单，不登录或发送消息。只有 `link` / `node` 时不请求订阅；配置了 `random` 时会真实获取订阅、验证候选容量并生成本轮计划，因此不能再把它当离线命令：

```sh
python routing.py prepare --manifest manifest.json
```

这一步主要验证外层 JSON、引用和分组；不能替代节点 URI 的完整语义检查、原生配置检查或连通性测试。清单包含公开账号 ID，仍不应把敏感信息当作 ID。

`python app.py` 和 **Ayrouter Daily Check-in** 都会进行真实账号操作，不能当作无副作用的语法检查。只有 **Credential-free platform smoke** 使用本地模拟站点和虚构凭据；GitHub 手动触发要求该工作流先存在于默认分支，仅开发分支存在时可能返回 404。

开发分支验证请新建 **Run workflow** 并选 `dev-plus`；重跑旧失败任务仍使用旧提交。计划任务运行默认分支版本，不会因推送 `dev-plus` 自动采用新代码。


## 12. 最终通知：历史余额、净变化、当前余额与出口 IP

新模式无需增加 JSON 字段，两种通知渠道都显示相同信息。示例：

```text
✅ ubuntu-24.04 random_ubuntu: 登录成功
  上次余额：10.00$
  余额变化：+1.00$
  当前余额：11.00$
  用户分组：default
  出口国家：未获取
  代理出口 IP：203.0.113.10
```

- 上次余额来自**同账号上次成功运行时读取的余额**，不是本次登录前实时读取的余额。净变化 = 当前 quota - 上次 quota，500000 quota = 1 美元；用未舍入整数计算差值再显示两位小数。
- 消费、充值、人工调整和其他客户端操作可能包含在净变化内，不能称作“签到奖励”。变化为负数时照实显示，例如 `-1.00$`；零余额也是成功的有效余额。
- 首次运行、缓存丢失/过期/被清理、换分支、账号 ID/站点/用户名改变时，历史基线未知。修改密码不改变账号身份。登录失败不会覆盖该账号已有成功基线，当前余额显示“未获取”；其他账号成功数据仍保存。
- Actions 的最终 `notify` 任务使用按分支区分的缓存，保存成功余额；本地新模式默认使用 `.superpowers/checkin-history/balances.json`。缓存和本地历史不是密码库，仅保存账号身份的 SHA-256 摘要及整数 quota，不保存用户名原文、密码、节点、机器人密钥或 IP。摘要不等于匿名化，已知或可猜测账号身份仍可被关联；缓存访问者还能看到余额。
- 出口 IP 通过**最后尝试/成功使用的那个代理**请求 `https://api.ipify.org` 得到，经 IPv4/IPv6 校验后展示。不是节点服务器地址，也不是本地代理端口或 runner 的公网 IP。没有可尝试候选、查询失败、重定向或返回非法内容时显示“未获取”，不影响有效登录结果，不改为直连查询。
- 查询设置连接/读取超时、限制响应大小，不重试或查询备用服务。它测量的是查询时的代理出口；轮转出口或按目标分流可能使站点实际看到不同 IP。程序不承诺 IP 唯一，也不宣称完全防关联。
- 完整出口 IP 会进入本轮短期结果 artifact 和机器人最终通知；历史缓存不保存 IP。Actions artifact/cache 和机器人接收者可能看到余额及活动信息，不要将结果当作不含敏感信息的匿名数据。旧变量模式仍保留原有余额通知，不新增历史或 IP 查询。

### 可点击 IP、出口国家与站点用户组

新模式无需增加 JSON 字段或 API 密钥：

- Telegram 把出口 IP 显示为 HTML 链接，企业微信最终汇总使用 Markdown 链接。地址为 `https://ippure.com/?ip=<URL编码后的出口IP>`，支持 IPv4/IPv6；无有效 IP 时不生成链接。公开页面已用保留测试地址验证查询参数及重新打开后的预填，不代表定位服务对该保留地址有国家数据。
- Telegram 含 IP 链接的消息关闭网页预览，避免自动预览请求。机器人发送和定位查询都不主动打开 IPPure 页面；读者点击链接时，IPPure 会收到 URL 中的出口 IP。其他客户端如何展示或预览链接由客户端决定。
- 最终汇总使用 IPWHOIS 的免费 HTTPS 接口 `https://ipwho.is/<IP>` 查询国家，只请求 `success,ip,country,country_code` 并指定 `lang=zh-CN`。显示示例为 `新加坡（SG）`；若服务返回英文名称则照实显示。查询只发送出口 IP，不发送账号、Cookie、代理凭据或机器人密钥。
- 一个最终汇总中，同一出口 IP 只查一次。未配置任何通知渠道时不查询国家；缺失 IP、非公网/保留地址、超时、限流、非法响应或返回 IP 不匹配时显示“未获取”，不重试、不切换服务、不影响登录状态或历史余额保存。
- 查询禁用环境代理和重定向，设置 5 秒连接/读取超时，响应最多 4 KiB。定位在最终通知任务进行，不重新启动账号浏览器，也不改变账号代理。官方当前免费额度为每客户端 IP 每天 1000 次；共享 runner 出口可能共同消耗额度，后续服务规则也可能改变。该额度不等于本站保证提供的可用查询次数。
- “用户分组”是已登录的站点 `/api/user/self` 响应中的 `data.group`，例如 `default` 或 `vip`，不是程序执行组 `g01/g02`。只接受 1～64 个可打印字符，不接受首尾空白、换行或控制字符。缺失/非法值显示“未获取”，不会猜测分组，也不额外发起登录或账户查询。
- 有效用户组随短期结果 artifact 保存，在 Telegram HTML 和企业微信 Markdown 中进行转义；余额历史缓存仍只保存身份摘要和整数余额，不保存用户组或国家。站点是否返回 `group` 取决于其 API 版本，不保证所有兼容站点都有该字段。
- 企业微信保留现有字节限长分段、限速与发送失败隔离；旧变量模式及直接调用文本发送函数的默认行为不改为 Markdown。不要为了配置定位服务随意添加未支持的 API 密钥字段，本版无需密钥。

服务文档：[IPWHOIS](https://ipwhois.io/documentation)、[Telegram LinkPreviewOptions](https://core.telegram.org/bots/api#linkpreviewoptions)。
