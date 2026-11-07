# Cloudflare 多仓库随机触发器

这个目录只部署 **Cloudflare Worker + SQLite Durable Objects**。它按目标独立调度 GitHub Actions，不运行 Python、浏览器、Xray 或签到机器人。实际登录和最终通知仍由各目标仓库自己的 `CHECKIN_CONFIG` 控制。

**代码可部署不等于已经部署或启用。** 首次部署不带业务变量，默认没有目标；示例全部为 `enabled: false`。连接 GitHub、保存令牌、真实触发和关闭原定时任务都需要你自行操作或另行授权。

## 先选对部署路径与分支

遇到界面默认 `main`，先看 Cloudflare 实际连接的是哪个仓库，**不要直接把所有 `main` 都改掉**：

| 你的部署方式 | Cloudflare 连接的源码仓库 | Production branch | Root directory |
| --- | --- | --- | --- |
| 连接本项目原仓库或保留全部文件的 Fork | 有 Python、`.github/` 和 `cloudflare/` 的签到仓库 | `main`，该分支必须包含本目录 | `cloudflare` |
| 点击下方按钮，克隆独立触发器 | Cloudflare 为你新建的仓库，根目录直接有 `package.json`、`wrangler.jsonc`、`src/` | 新仓库实际的默认分支，通常是 `main`，这是正常的 | 仓库根目录，留空或 `/` |

**三个分支概念互不替代：**

1. **Cloudflare Production branch**：控制从哪个源码分支构建、部署 Worker，在 Cloudflare Build / Branch control 中选择。
2. **`TRIGGER_CONFIG.targets[].ref`**：控制启动目标 GitHub Actions 的哪个分支，例如 `main`。修改它不会改变 Cloudflare 构建分支。
3. **目标签到仓库的 default branch**：GitHub 要求在这里注册 `workflow_dispatch`；旧 `schedule` 也在这里生效。它可以继续是 `main`，不必为了部署触发器修改仓库默认分支。

例如：独立触发器仓库用 `main` 部署 Worker，Worker 再触发 `yidu456/AgentRouter-Check-in` 的 `main`，而签到仓库默认分支保持 `main`，三者可以同时成立。`wrangler.jsonc` 不能强制 GitHub 集成选择生产分支；不要使用 Pages 的 `--branch` 参数，也不要把 `wrangler --env` 当成 Git 分支开关。

建议顺序：选部署路径 → 核对生产分支与目录 → 部署空目标 Worker → [创建并保存 API Token](API-TOKENS.md) → 配置停用的 `TRIGGER_CONFIG` → 核对目标工作流与旧定时入口 → 另行确认后启用。

## 部署方式

### 推荐：连接已有签到仓库

适合保留原仓库并让 `main` 的代码更新自动部署。使用 **Workers Builds**，不要创建 Pages 项目，也不要填写前端输出目录。

1. 确认自己的 GitHub 仓库已有 `main` 分支，且包含完整的 `cloudflare/` 目录。不要把别人的源码仓库误当成自己的签到目标仓库。
2. 在 Cloudflare **Workers & Pages → Create application** 中导入已有 GitHub 仓库，授权 Cloudflare GitHub App 访问这个源码仓库。若已有 Worker，在其 **Settings → Builds → Connect** 连接。
3. 核对以下设置，保存后启动构建部署：

| 构建设置 | 填写内容 |
| --- | --- |
| Worker / Project name | `agentrouter-trigger`，必须与 `wrangler.jsonc` 的 `name` 一致 |
| Production branch | `main`，不要沿用界面默认分支 |
| Root directory / Path | `cloudflare` |
| Build command | `npm test` |
| Deploy command | `npm run deploy` |
| Node.js | 22 或更新版本；如需指定版本，在构建环境中设置 `NODE_VERSION=22` |
| Preview builds | 在 **Settings → Build → Branch control** 关闭 **Enable Preview Builds** |
| Build variables and secrets | 不填写 `TRIGGER_CONFIG`、GitHub PAT 或签到 Secret |

包内锁定 Wrangler `4.158.0`；构建环境先安装依赖，`npm test` 执行不联网的模拟测试，部署命令打包并上传。首次部署的 `v1` / `new_sqlite_classes` migration 创建 `TriggerSchedule` 命名空间并绑定 `SCHEDULES`，不需要你填写命名空间 ID。部署前仍应核对账户支持 SQLite Durable Objects 及其额度。

之后推送生产分支会触发构建部署；不需要额外创建部署用 GitHub Actions。**源码的 GitHub 连接不会自动授予 Worker 触发 Actions 的权限，也不会自动读取其他 GitHub 账号的令牌。** 下文的运行时 PAT 必须另外配置。

### 已创建的 Worker 如何核对或切换分支

这一节只适用于“连接原签到仓库”，不适用于按钮新建且只有 `main` 的独立仓库。

1. 进入 **Workers & Pages → 你的 Worker → Settings → Build → Branch control**。部分界面将 Build 写成 Builds；这是 Worker 的构建设置，不是 GitHub 仓库 Settings。
2. 查看连接的 Git repository 是否确实是原签到仓库，再将 **Production branch** 下拉框改为 `main` 并保存。Cloudflare 默认选择 Git 仓库的默认分支，并不会因为部署按钮 URL 或 `ref` 写了 `main` 就永久更改这项设置。
3. 在同一构建设置中核对 **Root directory / Path = `cloudflare`**、**Build command = `npm test`**、**Deploy command = `npm run deploy`**、Worker 名称与配置一致，并关闭预览构建。
4. 若下拉框没有 `main`，先在 **当前连接的那个 GitHub 仓库** 的分支列表中确认它是否存在、是否已推送并包含 `cloudflare/`。Fork 不一定复制了非默认分支；只有本机存在的分支也不会出现。连接错了仓库则修正 Git 连接，不要修改另一个仓库的默认分支来绕过问题。
5. 保存后触发一次**来自 `main` 的新构建**，例如正常推送该分支上的文档或代码更新。不要只反复 Retry / Rerun 旧的 `main` 构建记录：重试针对原提交，不会把那个提交变成 `main` 最新提交。需要手工新建构建时，先核对界面实际选择的分支和提交。
6. 在新构建记录中核对源码仓库、分支、commit SHA 和生产部署结果。更改配置本身不会立即替换已部署版本；看到保存成功不等于新代码已上线。

若原仓库的 `main` 尚无 `cloudflare/`，从尚未同步触发器的 `main` 构建常见结果是找不到目录、`package.json` 或 Wrangler 配置。当前发布分支是 `main`，本目录已经包含在该分支。请同步正确仓库的发布代码；不需要重命名分支或修改 GitHub 默认分支。旧 `dev-plus` 仅是历史开发分支，不会因为发布代码自动修改你已保存的目标 `ref`。

### 部署完成后先核对这些

- 构建记录来自预期的源码分支；`npm test` 和 `npm run deploy` 均成功。
- Durable Object 绑定名为 `SCHEDULES`，类为 `TriggerSchedule`；Cron 为 UTC `5 16 * * *`，即北京时间 00:05。
- 首次没有运行时配置时不会签到，这是安全默认值，不是部署失败。
- `workers_dev: true` 开放只读状态页，`preview_urls: false` 关闭版本预览 URL；打开状态页不会签到。
- 确认 `TRIGGER_CONFIG` 在运行时 Variables & Secrets，而不是构建变量里；具体凭据步骤见 [API Token 完整指南](API-TOKENS.md)。

### 可选：按钮克隆独立触发器仓库

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yidu456/AgentRouter-Check-in/tree/main/cloudflare)

按钮需要源码仓库公开，并且指定分支/目录已推送。Cloudflare 会将 **只有 `cloudflare/` 的内容** 克隆到你账号下的新仓库根目录，然后创建 Worker、绑定资源和 Workers Builds；**不会克隆 Python 签到项目、工作流或 `CHECKIN_CONFIG`**，也不会自动设置触发令牌。你仍需要一个或多个单独的签到仓库。

这个独立新仓库的 Root directory 应为仓库根目录，而不是再次填写 `cloudflare`。核对构建命令 `npm test`、部署命令 `npm run deploy`，保留 Worker 名称 `agentrouter-trigger`，并关闭预览构建；生产分支以新仓库实际创建的分支为准，不假定也是 `main`。若账号下已存在本项目的同名 Worker，可改用连接已有仓库方式；若同名的是其他应用，先停止并另行确认部署方案，不要误覆盖。若想继续跟踪已有签到仓库的更新，使用推荐的连接已有仓库方式，按钮新建的仓库不会自动同步上游。

## 访问链接与只读状态页

部署成功后，到 Worker 的 **Settings → Domains & Routes** 复制 `workers.dev` 地址。通常形式为 `https://agentrouter-trigger.<你的账号子域名>.workers.dev/`；这里的子域名必须替换，不能从 GitHub 仓库名推断，也不是本指南声称已部署的地址。

- 打开 `/`：显示 JSON 格式和字段是否通过、Token 已配置/缺失/格式不合法数量、JSON 初始启用数量、存储绑定和可选企业微信配置；实际数据库开关仅在鉴权后的管理页查看。
- 打开 `/health`：返回同样的脱敏 JSON 状态，方便程序读取。公开页面和接口不显示目标 ID、仓库、分支、Secret 名称、密钥或完整配置。
- JSON 不合法会提示固定字段路径和修正方向，不回显错误值或原始解析异常。
- 已配置 Token / Webhook 仅表示存在并通过本地格式检查，**未验证 GitHub 权限、有效期或机器人送达**。状态页不请求 GitHub、企业微信或对象存储，不初始化日程，也不查询实际历史运行结果。
- 修改运行时变量后，保存并 Deploy，再刷新状态页。`no-store` 禁用缓存。页面是公开的，访问者能看到脱敏的配置状态和数量；有访问限制需要时，在 Cloudflare 配置 Access。
- 发布新代码会按 `workers_dev: true` 启用该地址。若想关闭公开状态页，需同步修改 Wrangler 为 false，再部署；仅在面板关闭可能被下一次部署重新启用。

## 运行时变量与凭据

部署成功后进入 Worker 的 **Settings → Variables & Secrets → Add**，修改后点击 **Deploy** 生效。这不是 **Build variables and secrets**：构建变量只在构建过程中可见，Worker 定时运行时读不到它们。

| 运行时名称 | 类型与内容 | 默认行为 |
| --- | --- | --- |
| `TRIGGER_CONFIG` | **Text / Plaintext**，值为下文 JSON 的完整文本；不要选择 JSON 对象绑定类型 | 未设置时目标列表为空，不请求 GitHub |
| `GITHUB_TOKEN_A` | **Secret**，目标 A 的真实 fine-grained GitHub PAT | 缺少或格式不适合的令牌时，不触发目标 A |
| `GITHUB_TOKEN_B` | **Secret**，目标 B 的真实 fine-grained GitHub PAT | 缺少时，不触发目标 B |
| `DEBUG_ACCESS_TOKEN` | 可选 **Secret**，独立生成的 32～128 字符 URL-safe 随机访问凭据 | 未配置、空值或不合法则关闭管理功能，不关闭自动调度 |
| `WECOM_WEBHOOK_URL` | **Secret**，完整企业微信群机器人 Webhook；可选 | 不配置则不发 Cloudflare 调度通知 |

`GITHUB_TOKEN_A/B` 是示例名称，不是系统自动提供的 GitHub Actions `GITHUB_TOKEN`。可使用其他合规名称，并让对应目标的 `token_secret` 引用它。JSON 中只放 Secret 名称，**绝不放 PAT 的值**。

`token_secret` 不得引用保留名称 `DEBUG_ACCESS_TOKEN`、`WECOM_WEBHOOK_URL`、`TRIGGER_CONFIG` 或 `SCHEDULES`；这些绑定不是 GitHub PAT，运行时拒绝用于触发。

推荐每个目标使用只授权该目标仓库的 fine-grained PAT，Repository permissions 授予 **Actions: Read and write**。不同 GitHub 账号分别创建各自获授权的令牌；组织仓库还需满足其审批/授权政策。`Actions: write` 不只允许一个工作流的 dispatch，也可能管理该仓库其他 Actions 资源，所以不要使用全仓库宽权限令牌。注意令牌过期、撤销和轮换。

**不知道去哪里创建 Token，或分不清 Cloudflare API Token 与 GitHub PAT？** 按 [API-TOKENS.md](API-TOKENS.md) 的逐步指南操作，包含创建页面、Resource owner、Only select repositories、最小 GitHub 权限、Cloudflare Secret 保存、双账号对应关系、轮换和 401/403/404 排错。Cloudflare 构建页的 API token 是部署凭据，不要把 GitHub PAT 填进去。

`wrangler.jsonc` 不包含 `vars`、账号 ID 或业务凭据，并启用 `keep_vars: true`，后续代码部署保留在界面配置的普通运行时变量。Wrangler 部署本身也不会删除已有 Secrets。保留变量不等于自动备份或恢复变量；更新前自行保留脱敏配置记录，真实令牌只保存在秘密管理位置。

## TRIGGER_CONFIG 完整字段

所有字段都必填，不接受未知字段。布尔值必须是 JSON `true` / `false`，不能是字符串。未设置变量表示无目标；空字符串、格式错误或任意目标不合法时，**整个配置停止自动调度**，日志记 `CONFIG_INVALID`，不会偷偷跳过错误字段运行其余目标。

| 字段 | 类型 / 示例 | 含义与限制 |
| --- | --- | --- |
| `version` | 数字 `1` | 配置版本，只接受 `1` |
| `targets` | 数组 `[]` | 空列表停用全部目标；最多 100 个目标，实际容量还受平台变量大小限制 |
| `targets[].id` | 字符串 `github_a` | 唯一且稳定的调度 ID；1～64 字符，字母/数字开头，随后字母、数字、`_`、`-` |
| `targets[].repository` | 字符串 `owner/repo` | 目标仓库，不是 URL；两部分均以字母/数字开头，可含字母、数字、`_`、`.`、`-`，各不超过 100 字符 |
| `targets[].workflow` | 字符串 `Checkin.yml` | 工作流文件名，以字母/数字开头，后续可含字母、数字、`_`、`.`、`-`，以 `.yml` 或 `.yaml` 结尾；不要填写 `.github/workflows/` 路径 |
| `targets[].ref` | 字符串 `main` | 已存在的目标分支，区分大小写；1～200 字符，字母/数字开头，后续可含字母、数字、`_`、`.`、`/`、`-`；禁止 `..`、连续 `/`、末尾 `/` 或 `.`、点开头的路径段和 `.lock` 路径段 |
| `targets[].token_secret` | 字符串 `GITHUB_TOKEN_A` | Worker Secret 名称，不是令牌；1～64 字符，大写字母开头，后续大写字母、数字、`_` |
| `targets[].enabled` | 布尔值 `false` | 单目标的初始开关，必须明确填写；管理页保存数据库开关后，以对应目标的持久状态为准 |

禁止重复 `id`，也禁止重复的仓库/工作流/分支组合；仓库名按大小写不敏感去重。运行时另有 64,000 字符输入上限，但 Cloudflare 的单变量大小限制通常先达到；不要将“最多 100 个目标”理解为平台保证可放下 100 个目标。例子中的两套账号彼此独立，同一天的抽签可以偶然重合。

```json
{
  "version": 1,
  "targets": [
    {
      "id": "github_a",
      "repository": "yidu456/AgentRouter-Check-in",
      "workflow": "Checkin.yml",
      "ref": "main",
      "token_secret": "GITHUB_TOKEN_A",
      "enabled": false
    },
    {
      "id": "github_b",
      "repository": "another-owner/AgentRouter-Check-in",
      "workflow": "Checkin.yml",
      "ref": "main",
      "token_secret": "GITHUB_TOKEN_B",
      "enabled": false
    }
  ]
}
```

请替换仓库示例。每个目标工作流必须声明 `workflow_dispatch` 且已在该仓库的**默认分支注册**；目标 `ref` 也必须存在并包含可运行的工作流。只向 `main` 新增工作流不代表默认分支已经注册。这个触发器只发送 `{"ref":"main"}`，不支持给其他工作流提供额外必填 inputs。各仓库的账号、代理、通知配置仍放在各自 GitHub Actions Secret `CHECKIN_CONFIG`，不要搬到 Worker。

不要随意重命名稳定 `id`、Worker 或对象类，也不要删除持久对象/命名空间；这些操作可能丢失去重状态。调整仓库、工作流或分支会使旧日程身份失效，旧 Alarm 不会改为立即触发新目标。停用、移除或令牌缺失的目标，旧 Alarm 到来时也不发送请求。

## 管理页与数据库（可选）

### 开启入口

无需 `debug` 模式变量，也无需创建 D1 数据库。现有 `wrangler.jsonc` 的 `SCHEDULES` 绑定和 `new_sqlite_classes` 迁移已经为每个目标提供独立 SQLite 存储；部署时由 Cloudflare 创建。开关、自动日程、近期日志和手动请求的防重复记录共用该存储，代码更新不会主动清空它。

1. 在自己的电脑生成独立高熵访问 Token，例如：

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

2. 在 Worker **Settings → Variables & Secrets** 添加 **Secret** `DEBUG_ACCESS_TOKEN`，粘贴生成值并保存、Deploy。只接受 32～128 个字母、数字、`_`、`-`；不要填 GitHub PAT、机器人密钥或便于猜测的密码。
3. 从 **Domains & Routes** 复制实际 HTTPS 地址，打开 `https://你的Worker域名/#token=生成的访问Token`。普通链接继续显示公开状态，只有通过鉴权后才下载仓库、日程和日志。

未配置、空值或格式不合法会关闭整个管理 API，但不会关闭原有自动调度。`#token=` 是 URL fragment，不随首页请求发送到服务器；页面读取后立即从地址栏移除，只在页面内存中保留，之后通过 Authorization 请求头验证。没有 Cookie、localStorage 或 sessionStorage 保存。刷新后需重新打开原 Token 链接；退出管理清除内存凭据并返回公开状态。不要改成 `?token=`，查询参数不会用于鉴权且可能进入日志。

完整管理链接相当于操作权限凭证，请勿截图、公开分享或保存在同步给他人的书签中。轮换/移除访问 Secret 后旧链接失效。独立 Token 不是多用户权限系统；不要给不信任的人使用。界面不会显示 GitHub PAT、Webhook、Secret 名称或完整原始 JSON。

### 开关、时间与手动运行

- 操作单位是 `id` 对应的仓库/工作流/分支组合；同一仓库的不同工作流或分支分别控制。
- 无数据库覆盖时使用 JSON 的 `enabled`。页面首次修改后，以数据库保存的开关为准；仅修改 JSON `enabled` 不会覆盖已保存的开关。仓库/工作流/分支改变后旧绑定的覆盖不再适用，新目标重新使用 JSON 默认值。只改 Token 或其 Secret 名称不重置开关。
- 关闭会撤销待触发 Alarm、禁止新的自动和管理页手动触发；无法取消已经发给 GitHub 的请求或正在运行的 Actions。
- 开启会保留仍在未来、未尝试且身份一致的自动日程。没有可用日程时按既定规则生成：01:00 前可排当天，否则排下一天；已经过期的计划不补跑。缺少 GitHub Token 时显示等待配置，不能手动触发。
- 下一次运行显示数据库里实际保存的未来目标时刻，统一为北京时间；关闭、缺少 Token、尚未初始化、存储错误都不猜一个时间。已过目标时刻但尚未完成的计划不会标成“下一次”，需核对平台延迟；浏览器读取不重抽或初始化日程。
- 手动运行必须点击并确认，独立记日志，不改变自动日程。结果“GitHub 已受理”不是 Actions 已完成或签到成功。未知时先核对 GitHub，不自动发第二次业务请求。

手动请求有 UUID 防重：同一个请求 ID 在 24 小时内重试只返回已保存结果，即使刚删除过显示日志也不重发。每个目标最多保留 100 条有效手动回执，达到上限拒绝新请求；不同手动请求间隔至少 30 秒。过期回执可清理，不保证超过 24 小时仍按同一请求 ID 去重。账号执行的并发锁仍由目标签到工作流负责。

### 近期日志与删除

每个目标保留最近 20 条自动/手动 dispatch 日志，包含北京时间、触发来源、GitHub 安全结果码和企业微信通知结果。不读 Actions 完整日志、不轮询签到结果，不保存 HTTP 正文、异常详情或密钥。旧版本只保存的上一条自动结果不会被伪装为完整历史。

支持确认后删除单条或清空该目标的显示日志。**删除仅影响管理页历史，不删除开关、日程、自动去重状态或手动回执**，也不删除 GitHub/Cloudflare 平台日志。不要用数据库的清空全部操作代替清空历史，丢掉去重状态可能引发重复触发。Cloudflare 存储备份/PITR 的保留策略与页面删除不同，这不是所有平台副本的安全擦除。

管理 API 需要 Bearer Token：`GET /api/admin/targets` 查看目标；`POST /api/admin/targets/:id/enabled`、`/run`、`/logs/delete`、`/logs/clear` 分别操作开关、运行和日志。只接受至多 1024 字节的 JSON 请求；不支持跨域调用。不要通过公开 GET 链接触发。

## 企业微信调度通知（可选）

1. 在企业微信群中创建普通群机器人，复制其完整 Webhook。
2. 在 Cloudflare 运行时 Variables & Secrets 添加 **Secret** `WECOM_WEBHOOK_URL`，保存完整 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`，发布后从首页查看本地配置状态。不要放到 `TRIGGER_CONFIG`、Build secrets、代码或聊天。
3. 每次实际 dispatch 请求得到结果后，触发器尝试发送一条中文文本：目标仓库、工作流、分支、自动/手动来源及对应日期、北京时间通知时间、受理/拒绝/不确定结果和工作流页面链接。
4. 示例中的“GitHub 已受理，不代表签到成功”只是调度结果；GitHub 最终账号汇总仍按原流程发送，通知时间也不是 runner 的精确启动时间。不新增 Cloudflare 轮询或跨仓库最终汇总。
5. 缺少 Token、目标停用或过期日程等没有实际 dispatch 的情况不发这条通知；配置错误可看状态页，调度详情看日志。

机器人结果校验 HTTP 200 和数字 `errcode: 0`；5 秒超时，最多读取 4 KiB，文本不超过 2048 UTF-8 字节，不跟随重定向。通知失败不改变 dispatch 结果，更不会重新启动 Actions。派发和机器人通知分别保守去重：先持久记录尝试状态，不对超时、进程故障或平台重复回调盲目重发。可能漏通知，需要到 GitHub 核对实际运行。

同一 Webhook 由多个目标和其他程序共享时，企业微信 20 条/分钟额度可能耗尽；触发器不强制错开独立随机时间，也不排队重发失败通知。机器人完整 URL 不出现在公开页面、状态 JSON、持久日程或日志中。

## 日程、失败与启用

- 时区固定北京时间 `Asia/Shanghai`。每个“目标 × 日历日期”从 **01:00～23:00（包含端点）** 的 1321 个分钟中均匀、独立抽签；允许与其他目标或前一天恰好相同，不保证强制错峰。
- 一个共享 Cron 为 `5 16 * * *`（UTC），即北京时间次日 **00:05**。它初始化/修复各目标日程；后续等待由 Durable Object Alarm 承担，不启动 Actions 进程睡眠。
- 仅设置 JSON 启用不会立刻执行签到或生成日程，等初始化 Cron；管理页开启目标会保存开关并按规则建立/恢复日程，但不立即签到。首次初始化若已到北京时间 01:00 或更晚，安排下一天，不补跑当天；00:05 的正常初始化可安排当天。已保存的日程不会因重复 Cron 或代码重部署重新抽签。
- 每个目标的每个自动日期最多一次 **HTTP 请求尝试**，不是“保证每天成功一次”。先持久记录尝试再请求 GitHub；支持 HTTP 200/204 受理，受理不表示签到已成功。
- 超时、中断或进程故障可能不知道 GitHub 是否收到请求，记 `DISPATCH_UNKNOWN`，**不盲目重发**。4xx/5xx 也不自动重复 dispatch；一个目标失败不阻止其他目标安排/触发。
- Cloudflare Alarm 至少一次交付和平台重试不等于重新发业务请求。过了北京时间日期的旧 Alarm 不补跑；同日期平台延迟可能使实际启动超过目标分钟或 23:00。Cloudflare 延迟、网络和 GitHub 排队都不是准点保证。
- 手动 Actions 运行仍立即执行，不写入 Cloudflare 自动日期标记；现有工作流并发锁负责避免同时登录。

### 正式开启前

1. 先部署默认停用状态，保持上述示例 `enabled: false`，配置各仓库限定 PAT，检查构建和安全日志。不要为了验证令牌直接调用真实 dispatch。
2. 检查每个目标的默认分支注册、`main`、`workflow_dispatch` 和 `CHECKIN_CONFIG`。
3. **另行确认后**，只移除目标仓库默认分支原有的 `on.schedule`，保留 `workflow_dispatch`。推送 `main` 不会自动关闭默认分支 Cron；也不能在 Actions 界面禁用整个工作流，否则外部触发不可用。
4. 在明确允许真实触发后，可先从 Actions 界面手动验证一次，然后在管理页开启已确认目标；没有数据库覆盖时也可将 JSON 改为 `enabled: true`。已保存页面开关的目标不能靠修改 JSON 重新开启。手动成功只能验证工作流，不等于验证 Worker PAT；第一次自动受理仍要在两边管理界面核对。

## 日志与排错

只读首页和 `/health` 可公开访问，不提供免鉴权手动触发或配置修改 API。首页/health 的 GET / HEAD 只校验本地配置、POST 返回 405，`/trigger` 等未知路径返回 404。公开页只报告 JSON 初始开关计数，不读取数据库覆盖或私人日程；真实状态在管理页查看。近期调度结果可在管理页查看，平台执行记录仍通过 Cloudflare Worker / Durable Objects 的 **Observability** 查看。

| 安全结果码 | 应检查什么 |
| --- | --- |
| `PLANNED` | 目标 ID、北京时间日期与已保存 UTC 目标时刻；不要把 UTC 显示直接当作北京时间 |
| `CONFIG_INVALID` | JSON 文本类型、所有必填字段、重复 ID/组合；整个配置不合法 |
| `TOKEN_MISSING` | 该目标 Secret 名称、是否真正存在、令牌格式；不要将令牌内容贴到日志或聊天 |
| `TARGET_DISABLED` / `TARGET_REMOVED` / `TARGET_CHANGED` | 旧 Alarm 对应的目标已停用、移除或修改，未发送请求 |
| `INIT_FAIL` / `STATE_INVALID` | 绑定、对象存储或初始化异常；先检查平台状态，不要删除存储强行重跑 |
| `DISPATCH_ACCEPTED` | GitHub 已受理；在目标仓库 Actions 查看 runner 和最终签到结果 |
| `DISPATCH_HTTP_401` / `403` / `404` 等 | PAT 过期/权限/组织授权、仓库和默认分支工作流注册、目标分支；不打印响应正文 |
| `NOTIFY_NOT_CONFIGURED` / `NOTIFY_CONFIG_INVALID` | 未配置可选 Webhook 或其格式不合法，dispatch 结果保持不变 |
| `NOTIFY_ACCEPTED` / `NOTIFY_FAILED` / `NOTIFY_UNKNOWN` | 机器人受理、失败或送达不确定；不是 Actions 签到结果，不自动重发 |
| `DISPATCH_UNKNOWN` | 网络超时等不确定结果；先核对 Actions 有无该运行，再决定是否手动运行 |
| `MISSED_DATE` | 旧日程已跨北京时间日期，或关闭后重新开启时目标时刻已过；不补跑。普通同日期延迟修复和重复开启已启用目标不会跳过既有日程 |

业务日志只记录受限 ID、日期、目标时间和安全码，不记录 PAT、请求头、响应正文、签到凭据或异常详情。日志中的 `DISPATCH_UNKNOWN` 也会在请求前先写入，所以应查看后续最终码；若之后没有确定结果，按不确定处理。没有启动的工作流不会发最终机器人报告，触发故障要在 Cloudflare/GitHub 管理界面检查，不会自动跨仓库汇总到机器人。

### 停用与回滚

先在管理页关闭目标；没有数据库覆盖时也可把 JSON 改为 `enabled: false`。停止全部目标可保存 `{"version":1,"targets":[]}` 并 Deploy，再确认不再有新的自动触发。仅移除 `DEBUG_ACCESS_TOKEN` 不会停用调度。已有在途 HTTP/Actions 运行不能被停用配置撤回。需要恢复原定时任务时，再另行恢复各默认分支 `on.schedule`，避免两个入口同时自动执行。

**回退到不认识数据库开关的旧代码前，必须先保存 `{"version":1,"targets":[]}` 并 Deploy，确认停用后再回退。** 仅页面关闭可能被旧代码的 JSON `enabled: true` 重新启用；仅改 JSON false 也可能被新代码的数据库 true 覆盖。空目标列表同时约束两种版本。不要删除对象数据、重命名 ID 或倒退 migration 以试图重新执行今天。`keep_vars` 会保留已有配置，重部署旧代码不等于停用。

## 本地检查与费用

需要 Node.js 22+，从这个目录运行：

```sh
npm ci
npm test
npm run check
```

`npm test` 使用 Node 内置测试器，GitHub HTTP、时间和对象存储均由测试替身控制；不读取业务令牌，不真实登录或发送通知。`npm run check` 是 `wrangler deploy --dry-run`，只做本地打包检查，不上传。真实部署命令是 `npm run deploy`，需另行授权与 Cloudflare 登录，不属于这些本地检查。

等待时没有长连接、内存计时器或全天运行进程；通常每天一个共享 Cron，N 个目标约 2N 次对象调用，另加初始化、恢复和平台重试。打开/刷新管理列表会查询各配置目标的对象，操作开关、运行和删除也产生读写，并非免费无限刷新。Worker、Durable Objects、存储、日志及 Workers Builds 仍受各自额度/计费约束，不承诺永久零费用；实际签到 Actions 用量由各 GitHub 账号承担。大量目标还受变量大小、子请求和 Cron 执行限制，本项目不是无限规模调度服务。

官方参考：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[构建设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[部署按钮限制](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[运行时变量](https://developers.cloudflare.com/workers/configuration/environment-variables/)、[Wrangler keep-vars](https://developers.cloudflare.com/workers/wrangler/commands/workers/)、[Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)、[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。

分支参考：[修改生产分支](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/#change-production-branch)、[针对原提交重试构建](https://developers.cloudflare.com/changelog/post/2025-03-17-rerun-build/)。
