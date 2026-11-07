# CHECKIN_CONFIG 配置手册

账号、系统、账号自己的代理和固定浏览器配置，都放在一个 GitHub Actions Secret：`CHECKIN_CONFIG`。在 **Settings → Secrets and variables → Actions → New repository secret** 创建；值是完整 JSON，不加外层引号、代码围栏或注释，不放公开 Variables 或仓库文件。

**推荐 `version: 2`：系统在外层，每个系统下有多个账号。** 下列邮箱、密码、节点、UUID 和机器人凭据都是虚构数据；字段合法不代表能连接、登录或发送消息。解析器以 `routing.py`、节点支持范围以 `proxy_runtime.py` 为准，不是任意客户端/Xray 配置导入器。

## 1. 三系统完整示例

每个系统有两个账号，每个账号有自己的 1～N 个候选和 `profile`。`profile: {}` 固定使用默认基本配置，不随机生成。示例含订阅名称和随机候选，需要替换订阅、固定名称以及直接链接；有效随机池还需至少两个未被固定绑定占用的节点。

```json
{
  "version": 2,
  "subscription_url": "https://subscription.example.com/sub?format=links",
  "notifications": {
    "telegram": {"bot_token": "example-token", "chat_id": "-1001234567890"},
    "wecom": {"webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-key"}
  },
  "groups": {
    "ubuntu": {
      "accounts": [
        {
          "id": "ubuntu01", "username": "one@example.com", "password": "example:secret|one",
          "proxies": [
            {"link": "socks5://ubuntu-primary.example.com:1080#ubuntu01-primary"},
            {"link": "socks5://ubuntu-backup.example.com:1080#ubuntu01-backup"}
          ],
          "profile": {"viewport": {"width": 1280, "height": 720}, "locale": "zh-CN"}
        },
        {
          "id": "ubuntu02", "username": "two@example.com", "password": "example-two",
          "proxies": [{"link": "socks5://ubuntu-second.example.com:1080#ubuntu02"}],
          "profile": {}
        }
      ]
    },
    "macos": {
      "accounts": [
        {
          "id": "mac01", "username": "three@example.com", "password": "example-three",
          "proxies": [
            {"node": "mac-primary"},
            {"link": "trojan://example-secret@mac-backup.example.com:443?sni=tls.example.com#mac01-backup"}
          ],
          "profile": {"viewport": {"width": 1440, "height": 900}, "device_scale_factor": 2}
        },
        {
          "id": "mac02", "username": "four@example.com", "password": "example-four",
          "proxies": [{"random": 2}],
          "profile": {"locale": "en-US", "timezone_id": "Asia/Tokyo"}
        }
      ]
    },
    "windows": {
      "accounts": [
        {
          "id": "win01", "username": "five@example.com", "password": "example-five",
          "proxies": [{"link": "socks5://windows-first.example.com:1080#win01"}],
          "profile": {"viewport": {"width": 1920, "height": 1080}, "color_scheme": "dark"}
        },
        {
          "id": "win02", "site": "https://agentrouter.org",
          "username": "six@example.com", "password": "example-six",
          "proxies": [{"link": "socks5://windows-second.example.com:1080#win02"}],
          "profile": {"locale": "en-US", "timezone_id": "Europe/London"}
        }
      ]
    }
  }
}
```

只需一个系统时删掉另外两个系统；空系统写 `{"accounts": []}`，不要写 `null` 或 `{}`。全部系统合计至少一个账号。**v2 账号不写 `os`**，即使与外层相同也拒绝，避免两处配置歧义；系统下不能设共用代理、profile 或账号凭据。

### 旧格式仍兼容

`version: 1` 保留顶层 `accounts` 数组和每账号必填的 `os`，无需迁移。v1/v2 的其余账号、代理、profile 和通知字段完全相同；不能混用顶层 `accounts` 与 `groups`。

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "ubuntu01", "username": "user@example.com", "password": "example-secret",
      "os": "ubuntu", "proxies": [{"link": "socks5://proxy.example.com:1080"}]
    }
  ]
}
```

非空 `CHECKIN_CONFIG` 不从 `ACCOUNTS`、`USERNAME`、`PASSWORD` 或旧通知变量补全，坏配置直接失败。删除/清空 Actions Secret 会回到旧模式；旧模式有免费代理及应用层直连兜底，需要严格自有代理时不要清空 Secret 来掩盖配置错误。本地显式设置空配置会失败。

## 2. 字段表

### 顶层和系统

| 字段 | 类型 / 必填 | 允许值 / 默认值 |
| --- | --- | --- |
| `version` | 整数，必填 | `2`（推荐系统外层分组）或 `1`（旧账号数组）；拒绝字符串、小数、布尔值 |
| `groups` | v2 必填对象 | 仅 `ubuntu`、`macos`、`windows`；系统可省略，每个出现的系统对象只能含 `accounts` 数组 |
| `accounts` | v1 必填非空对象数组 | v2 禁止在顶层填写，改放 `groups.<系统>.accounts` |
| `subscription_url` | 有 `node`/`random` 时必填字符串 | HTTPS，主机非空；不能有前后空白、URL 用户名/密码、片段；端口若出现为 1～65535。仅 `link` 时可省略 |
| `notifications` | 可选对象 | 省略或 `{}` 关闭；只支持 `telegram`、`wecom`，见第 5 节 |

| 系统键 / v1 `os` | 实际 GitHub Runner | 原生浏览器 |
| --- | --- | --- |
| `ubuntu` | `ubuntu-24.04` | Linux Chromium |
| `macos` | `macos-15`（ARM64） | macOS Chromium |
| `windows` | `windows-2022` | Windows Chromium |

仅接受上述小写系统，不接受 `linux`、`MacOS`、`macos-15`；`macos-14` 已退役。执行组顺序仍为 Ubuntu → Windows → macOS，各系统账号按 ID 排序，每三个划为一个工作组；不是 JSON 的填写顺序。每账号代理顺序不变，系统与账号固定绑定，不会每天随机换系统。内部规范化为旧版账号清单，因此现有 manifest、报告和工作流格式不变。

### 账号

| 字段 | 类型 / 必填 | 允许值 / 默认值 |
| --- | --- | --- |
| `id` | 必填字符串 | 全配置唯一、区分大小写；英文字母开头，后续英文字母/数字/`_`/`-`，总长 1～32 |
| `username` | 必填字符串 | 非空且非纯空白，通常登录邮箱，原样保留 |
| `password` | 必填非空字符串 | 原样保留冒号、竖线、前后空格；特殊字符按 JSON 转义，不按 URL 编码 |
| `proxies` | 必填非空对象数组 | 每项恰好一个 `link`、`node` 或 `random`；见第 3 节 |
| `site` | 可选字符串 | 默认 `https://agentrouter.org`；HTTP/HTTPS 或省略协议自动补 HTTPS，可带路径前缀；禁止空白、URL 凭据、查询、片段 |
| `profile` | 可选对象 | 省略或 `{}` 使用第 4 节默认值；不接受 `null` |
| `api` | 可选对象 | 余额读取的管理 API 凭据兜底，不必配置；只能含下表两项 |
| `os` | 仅 v1 必填字符串 | `ubuntu`/`macos`/`windows`；v2 禁止，继承外层系统 |

ID 会出现在清单、日志、报告和通知，不要用邮箱或密钥。相同规范化站点 + 相同原样用户名只能登记一次，不能把同一账号分配到三个系统。`site` 后追加 `/login`，通常填不带末尾斜线的站点根地址，不是任意登录页 URL；其他站点须兼容当前登录表单和用户 API。

### 可选余额 API 凭据：默认不需要

优先使用本次浏览器登录的 Cookie/站点会话，无需自己创建密钥。仅兼容站点确实要求管理 API 鉴权时，在该账号补充：

```json
{"api": {"access_token": "example-management-access-token", "user_id": 42}}
```

| 字段 | 类型 / 必填 | 允许值 |
| --- | --- | --- |
| `api.access_token` | 出现 `api` 时必填字符串 | 管理账户 Access Token/PAT，1～4096 个可打印非空白 ASCII 字符；禁止空格、换行、控制字符、非 ASCII |
| `api.user_id` | 出现 `api` 时必填整数 | 站点用户 ID，1～9007199254740991；不能为字符串、小数或布尔值 |

不是模型调用用的 `sk-...` 令牌，不支持自定义 API URL。该令牌不能作为网页登录成功证据；只能在独立确认本次网页登录用户身份、且 `user_id` 匹配后兜底访问同站点 `/api/user/self`。不要填另一个账号的令牌或 ID，不额外获取管理密钥来规避登录失败。与其他凭据一样只放 Secret，不进入公开清单或余额历史。

### JSON 通用限制与特殊字符

标准 JSON，无注释、尾逗号、`NaN`/`Infinity`、重复键或未知字段；缺省值靠省略，不用 `null`/空字符串替代。UTF-8 总大小 ≤48 KiB（49152 字节），最多 256 个执行组，各组最多三个账号；全配置展开代理总数 ≤47456（`random: 2` 计两个）。

账号密码转义例：`"example:secret|with\"quote\\slash"`。节点鉴权与查询值使用 URL 编码：`:`→`%3A`、`@`→`%40`、`#`→`%23`、`&`→`%26`、`+`→`%2B`；查询中未编码 `+` 被视为空格，不要重复编码客户端的完整链接。

## 3. 每账号自己的 1～N 个代理

| 候选对象 | 类型 / 允许值 | 条件 |
| --- | --- | --- |
| `{"link": "..."}` | 非空完整节点分享 URI，无前后空白 | 不是订阅 URL；支持协议见第 6 节 |
| `{"node": "mac-primary"}` | 非空订阅节点名，无前后空白 | 必须有顶层 `subscription_url` |
| `{"random": 2}` | 严格整数 1～47456，非字符串/小数/布尔值 | 必须有 `subscription_url`；还受全局候选及实际有效节点数限制 |

可按需混合，位置保留、多个随机项计数相加，例如：

```json
{"proxies": [{"node": "fixed-primary"}, {"link": "socks5://fixed-backup.example.com:1080"}, {"random": 2}]}
```

- 从第一个可尝试候选开始，失败关闭浏览器再试下一个，首次成功立即停止；全部失败只影响该账号，不借其他账号节点，不用免费代理、不直连。配置/原生检查失败候选先过滤，`attemptN` 是登录控制器列表序号，未必是原 JSON 下标。
- 同一 `node` 名或直接链接身份全配置不能重复，`#备注` 不参与比较。仅固定引用不能识别全部 `node`/`link` 交叉重复；节点不同也不保证实际出口 IP 不同，请自行确认独立出口。
- 随机模式 `prepare` 获取订阅并生成本轮种子/带密钥的池指纹，worker 再读取订阅校验一致，全局按账号 ID 重建分配。先移除所有固定绑定，按可识别的有效节点配置去重，跨系统、跨组、跨账号不重复分配；未使用候选也不借给其他账号。
- 纯随机池允许无名、重名、改名、排序变化，跳过不支持/非法节点；订阅限明文/base64/base64url 链接列表，最大响应 4 MiB，带超时，不支持 Clash YAML/sing-box JSON。混有 `node` 时仍严格要求名称唯一且存在。
- 固定绑定重复/无效、随机容量不足或准备后有效池/完整配置变化，安全失败，不登录、不重新抽、不共享、不直连；新运行才重新抽。固定名称改名不可忽略。清单只有种子/带密钥指纹，没有节点凭据；完整性指纹不是节点加密，也不保证每轮抽到不同节点。

## 4. 固定 `profile`

| 字段 | 类型 / 允许值 | 默认值 |
| --- | --- | --- |
| `viewport` | 对象，恰好整数 `width`/`height`，各 320～8192 | 1440 × 900 |
| `screen` | 同上，各维不能小于 viewport | 填了 viewport 则跟随；否则 1440 × 900 |
| `device_scale_factor` | 严格整数 `1`/`2` | `1` |
| `locale` | `zh-CN`/`en-US` | `zh-CN` |
| `timezone_id` | `Asia/Shanghai`/`Asia/Tokyo`/`America/New_York`/`Europe/London` | `Asia/Shanghai` |
| `color_scheme` | `light`/`dark` | `light` |

完整局部例：

```json
{
  "profile": {
    "viewport": {"width": 1280, "height": 720},
    "screen": {"width": 1920, "height": 1080},
    "device_scale_factor": 2, "locale": "en-US",
    "timezone_id": "Europe/London", "color_scheme": "dark"
  }
}
```

只设置 1280 × 720 的 viewport 时，screen 也变为 1280 × 720。仅上述六项；不支持 `user_agent`、platform、浏览器版本、Canvas/WebGL、字体/硬件伪装。用原生系统 Playwright Chromium 默认 UA，不是 Google Chrome stable，也不在 Ubuntu 伪造 macOS；固定这些属性不等于固定完整硬件指纹或保证账号不可关联。

## 5. 最终通知渠道

| 字段 | 类型 / 要求 |
| --- | --- |
| `notifications.telegram` | 对象，只能且必须同时含 `bot_token`、`chat_id` |
| `bot_token` | 非空字符串，Telegram Bot Token |
| `chat_id` | 非空字符串，例如 `"123456789"`/`"-1001234567890"`，不是 JSON 数字 |
| `notifications.wecom` | 对象，只能且必须含 `webhook_url` |
| `webhook_url` | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`；端口省略/443，恰好一个非空 key，禁止其他查询、片段、URL 凭据及前后空白 |

两渠道可同时配置（见完整例）；关闭一个就删掉该对象，全部关闭省略 `notifications` 或 `{}`，不能用空渠道对象或 `null`。微信群机器人无需且不支持 `corp_id`、`agent_id`、`corp_secret`。

全部执行组结束后才发最终汇总，缺失/损坏报告计失败，不发送中途日志。超长汇总分段，企业微信每段 ≤2048 UTF-8 字节并限速；渠道失败相互隔离，发送失败不自动重试。字段合法不代表密钥/权限/Chat ID 可用；整个 JSON 非法时不从坏配置提取密钥、不混用旧变量，可能只有 Actions 状态和安全日志。

## 6. 节点链接支持的字段与完整示例

所有协议都需要有效节点服务器地址和 1～65535 端口。节点 URI 的外层查询参数不允许重复同名键，不支持的参数会失败，而不是偷偷忽略；WS 路径内部的查询规则另见 `ed` 说明。特殊字符必须按 URL 编码；`#备注` 是可选名称，不是鉴权信息。

### 6.1 VLESS

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

### 6.2 VMess

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

### 6.3 Trojan

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

### 6.4 Hysteria2 / Hy2

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

### 6.5 SOCKS5 / SOCKS

两种协议前缀都按 SOCKS5 处理，无查询参数：

```text
socks5://node.example.com:1080#socks-no-auth
socks://example-user:example-password@node.example.com:1080#socks-auth
socks5://example-user:example%3Asecret%40value@node.example.com:1080#socks-encoded-password
```

可以不填鉴权；填写用户名时必须同时带密码位置，即 `user:password@`，不能写成 `user@`。用户名非空，空密码位置可以存在，但服务器是否允许取决于其配置。不能添加 `?username=...`、`?password=...` 等查询参数，也不支持把 `http://proxy...` 当作 `link`。

## 7. 校验、故障与安全边界

只检查外层 JSON、**不联网、不登录、不发送通知、不生成凭据文件**（先设置环境变量）：

```sh
python -c "import os; from routing import parse_config; parse_config(os.environ['CHECKIN_CONFIG']); print('CONFIG_VALID')"
```

```sh
python -m py_compile app.py routing.py
bash -n setup-proxy.sh
python -m unittest discover -s tests
```

`python routing.py prepare --manifest manifest.json` 不登录/发送消息；固定 `link`/`node` 不获取订阅，含 `random` 时会真实获取订阅并生成本轮计划，**不是离线命令**。字段检查/清单不能替代 URI 完整语义检查、内核检查或连通性测试。

`python app.py` 和 **Ayrouter Daily Check-in** 会真实操作账号。仅 **Credential-free platform smoke** 使用本地模拟站点及虚构凭据；手动 Actions 要求该工作流先存在于默认分支。新建 Run workflow 并选择要测的分支，重跑旧任务仍用旧提交，计划任务用默认分支。

| 状态码 | 检查方向 |
| --- | --- |
| `ROUTE_CONFIG_FAIL`/`SCRIPT_FAIL` | JSON 类型、字段、重复绑定、系统或任务分配 |
| `NODE_SOURCE_FAIL`/`NODE_MISSING` | 订阅读取/解码/重名/格式，引用名称缺失或不可用 |
| `NODE_CONFIG_FAIL`/`PROXY_START_FAIL` | URI、协议组合/参数、原生检查/启动/端口/就绪 |
| `BINARY_DOWNLOAD_FAIL`/`BROWSER_LAUNCH_FAIL` | 内核下载/哈希/平台/ZIP，或 Chromium 启动；不是必然节点故障 |
| `NODE_UNREACHABLE` + `NAVIGATION_FAIL` | 所选代理导航失败；安全 Chromium 网络码可提示连接/DNS/TLS 方向 |
| `GOTO_TIMEOUT`/`PAGE_TIMEOUT`/`WAF_TIMEOUT` | 导航/页面操作/就绪检查超时，不能证明被 WAF 拦截 |
| `FORM_NOT_FOUND`/`FORM_OPERATE_TIMEOUT` | 邮箱入口、可见用户名/密码/提交控件或操作阶段；尚未成功点击提交，部分输入可能已填写，不是密码错误结论 |
| `USER_API_FAIL`/`API_PAYLOAD_FAIL`/`QUOTA_INVALID` | 用户 API/身份/结构或余额非法；quota 必须为 0～9223372036854775807 整数，布尔值不算；独立确认登录后余额不可用不改为登录失败 |
| `RANDOM_POOL_FAIL`/`PROXY_LIST_EXHAUSTED` | 池容量/完整性/固定绑定冲突，无可尝试候选；随机校验失败不登录 |
| `UNFINISHED`/`JOB_MISSING`/`REPORT_INVALID`/`PREPARE_FAIL` | 未完成、报告缺失/无效或准备失败，汇总不算成功 |
| `UNEXPECTED`/`UNKNOWN`/`NO_PROXY` | 未分类异常，或旧模式无可用代理；不输出可能含凭据的原始异常 |
| `SUCCESS` | 本次浏览器登录身份已独立验证，不能手工写入配置；不保证余额可读或签到奖励到账 |

报告只保留最后失败阶段，日志另存各尝试阶段，不能仅看最终码就判断代理服务器坏了。当前表单适配中文“使用 邮箱或用户名 登录”、英文 `Sign in with Email or Username` 和可见 `username`/`password`/`button[type="submit"]`；其他网站仍可能不兼容。就绪启发式放行不代表真正通过 WAF/认证；排查只核对公开表单或脱敏阶段，不提供密码、Cookie、localStorage 或个人截图。

真实 JSON、订阅、节点、API Token、Webhook 只放 Secret。拿到完整 Secret 的任务能读取全部账号/通知凭据，多系统/进程不等于互不信任的凭据隔离。已公开的凭据应轮换，不只是删文本。

内核固定 Xray **26.1.23** 以兼容显式 `allowInsecure`；默认仍验证证书。显式 `1` 失去服务端身份验证，较新版本已移除该开关。该兼容版本不是最新安全基线，禁用 MPTCP 不代表所有后续修复已包含，也不开放受 Hy2/gRPC CA 固定问题影响的 CA 固定字段；长期应使用有效证书、删不安全选项后升级，不靠放宽校验或直连掩盖故障。

## 8. 通知中的余额、用户组和出口

无需额外 JSON 字段/API 密钥，两渠道显示同一份最终信息：

```text
ubuntu-24.04 ubuntu01: 登录成功
  上次余额：10.00$
  余额变化：+1.00$
  当前余额：11.00$
  用户分组：default
  出口国家：未获取
  代理出口 IP：203.0.113.10
```

- 上次余额来自同账号**上次登录成功且读到有效余额的运行**，不是本次登录前实时余额；净变化以未舍入整数 quota 计算，500000 quota = 1 美元，显示两位小数。消费/充值/人工调整/其他客户端可能包含在差额内，不能称“签到奖励”；负变化如实显示，零余额合法。
- 首次/缓存丢失、过期、清理/换分支/账号 ID、站点、用户名变更时基线未知，密码变更不改身份；登录失败或余额不可用不覆盖既有基线，当前余额“未获取”、变化“未知”，其他账号有效余额仍保存。Actions notify 使用按分支区分的缓存，本地默认 `.superpowers/checkin-history/balances.json`；只保存身份 SHA-256 摘要及整数 quota，不存原用户名、密码、API Token、节点、机器人密钥或 IP。摘要可关联猜测身份，缓存访问者能看到余额。
- 出口 IP 经最后尝试/成功代理请求 `https://api.ipify.org` 并校验 IPv4/IPv6，带超时/限长、无重试/备用服务/重定向/直连；失败显示“未获取”且不影响有效登录。不是节点服务器/本地端口/runner 公网 IP；轮转或按目标分流可与目标站实际所见不同，不保证独立出口或防关联。
- Telegram HTML 和企业微信 Markdown 把有效 IP 链接到 `https://ippure.com/?ip=<URL编码IP>`，IPv4/IPv6 均支持，未获取不生成链接。Telegram 关闭网页预览；程序不主动打开定位页，但读者点击会向 IPPure 暴露 IP，其他客户端预览行为由客户端决定。
- 最终汇总通过免费 `https://ipwho.is/<IP>` 查询 `success,ip,country,country_code`、`lang=zh-CN`，同 IP 本轮只查一次。无通知渠道/非公网保留 IP/非法、超时、限流、IP 不匹配均不查或显示“未获取”，不重试/换服务，不影响余额；只发送出口 IP、不发送账号/Cookie/凭据，禁用环境代理和重定向，5 秒连接/读取超时，最大 4 KiB。示例 `新加坡（SG）`，英文结果原样展示；免费额度当前每客户端 IP 每天 1000 次，共享 runner 可共同消耗，服务规则可能改变。
- 用户组来自登录站点 `/api/user/self` 的 `data.group`，不是执行组 `g01`；仅 1～64 个可打印字符，无首尾空白/换行/控制字符。缺失/非法显示“未获取”，不额外登录或查询；报告保存、消息转义，不存入余额缓存。
- 完整 IP、用户组、余额进入短期结果 artifact 和通知，国家查询接收者也能看到 IP；artifact/cache 和机器人接收者可能看到活动信息，不是匿名数据。旧变量模式不新增历史/IP/国家查询；企业微信保留分段限速及发送隔离，文本发送函数默认行为不变。

### 历史余额“未知”怎么查

| 通知 / 日志码 | 含义 |
| --- | --- |
| `HISTORY_MISSING` / `HISTORY_LOAD_MISSING` | 历史文件不存在；首次、缓存未命中/过期/清理或换分支都可能导致 |
| `HISTORY_INVALID` / `HISTORY_LOAD_INVALID` | 文件格式、大小或内容校验失败；本轮基线未知，以有效余额重建 |
| `HISTORY_READ_FAILED` / `HISTORY_LOAD_READ_FAILED` | 文件读失败；不覆盖不可读文件，本轮也不保存历史 |
| `HISTORY_NO_BASELINE` | 已读取合法历史，但没有当前身份的记录；检查是否首次账号或更换 ID/站点/用户名 |
| `HISTORY_LOAD_RESTORED` | 合法历史文件已读取，不代表每个当前账号都有基线 |
| `HISTORY_SAVE_FAIL` | 本轮本地历史未保存；有效登录/余额仍展示，但下轮可能缺基线 |

通知只在基线未知或本地保存失败时加诊断行。Actions 的 `notify` 日志另有 `HISTORY_CACHE_MISSING`/`RESTORED`/`RESTORE_FAIL`/`SAVE_SUCCESS`/`SAVE_FAIL`（均带 `HISTORY_CACHE_` 前缀），区分远端缓存恢复和保存；远端保存发生在通知后，不能以通知没有报错证明缓存保存成功。成功保存后的下一轮，同分支、同账号身份才可算差额；“未知”本身不足以认定缓存缺陷。 多个独立工作流共用同一余额历史时，须使用相同 concurrency group 串行执行，否则并发保存的缓存快照可能遗漏另一工作流的更新。

服务文档：[IPWHOIS](https://ipwhois.io/documentation)、[Telegram LinkPreviewOptions](https://core.telegram.org/bots/api#linkpreviewoptions)。
