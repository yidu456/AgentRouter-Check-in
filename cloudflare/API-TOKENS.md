# API Token 创建与配置指南

本指南只说明如何配置，不会替你创建凭据、调用真实 dispatch 或修改仓库默认分支。先部署空目标或 `enabled: false` 的触发器，最后再启用。

已有 Worker 可能保留数据库开关；`enabled: false` 示例不是覆盖数据库 true 的停用保证。更新已有项目需先查看管理页有效状态；需要确保所有目标停用时，保存空 `targets` 列表并发布，不要清空数据库。

## 1. 先分清授权与访问凭证

| 凭据 / 授权 | 从哪里获得 | 用途 | 放在哪里 |
| --- | --- | --- | --- |
| Cloudflare GitHub App 连接 | Cloudflare 连接 GitHub 仓库时授权 | 读取触发器源码、跟随源码提交构建 | Cloudflare Git connection；不是运行时 Secret |
| Cloudflare API Token / build token | Workers Builds 自动创建，或 Cloudflare API Tokens 页面创建 | 将 Worker、绑定和 Cron 部署到 Cloudflare | Worker 的 Build 设置中的 API token；不是 `GITHUB_TOKEN_A` |
| GitHub fine-grained PAT | 目标 GitHub 账号的 Settings → Developer settings | Worker 请求目标仓库的 GitHub Actions `workflow_dispatch` | Cloudflare **运行时** Secret，例如 `GITHUB_TOKEN_A` |
| 管理页访问 Token（可选） | 自己生成独立随机值，不在 GitHub 或 Cloudflare API 页面申请 | 查看仓库、开关、日程、调度日志和确认后手动触发 | Cloudflare **运行时** Secret `DEBUG_ACCESS_TOKEN` |

**自动调度在运行时需要 GitHub PAT，不需要 Cloudflare API Token。** GitHub App 的源码连接不会自动赋予 Actions 触发权限；Cloudflare build token 也不能用来调用 GitHub。管理页另用独立访问 Token，不能拿 GitHub PAT 当页面密码。

`TRIGGER_CONFIG` 是普通 JSON 配置，不是令牌。账号密码、代理订阅和通知密钥仍保留在各签到仓库的 GitHub Secret `CHECKIN_CONFIG`。

### 可选管理页访问 Token

在自己电脑运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`，把输出作为运行时 **Secret** `DEBUG_ACCESS_TOKEN` 保存并发布。只接受 32～128 个字母、数字、`_`、`-`，不要重用其他凭据，也不要把真实值贴到聊天或提交到 Git。

访问固定 `https://你的Worker域名/token` 输入访问 Token；快捷链接为 `/token#token=随机值`。`#token=` 不随首页请求传到服务器，页面立即清除地址栏 fragment，再用请求头鉴权。Token 只在页面内存中，刷新需重新输入或打开快捷链接。没有配置、留空或格式错误则管理功能关闭，自动调度不因此停用。删除/轮换 Secret 会撤销原链接的操作权限。普通首页仅显示 hello world；配置状态和仓库详情均需鉴权。

完整链接也属于凭据，避免公开分享、同步书签或截图。管理 Token 持有者可启停和手动触发所有配置目标，并删除显示日志；它不是只读权限。数据库和开关优先级见 [管理页说明](README.md#管理页与数据库可选)。

## 2. 创建 GitHub fine-grained PAT（必需）

### 2.1 打开正确页面

1. 若目标是个人仓库，登录**该仓库所有者**的 GitHub 账号；若目标是组织仓库，登录该组织的正式成员账号，并确认其有相应仓库权限。不要随意使用拥有触发器源码的另一个账号。
2. 头像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**。
3. 点击 **Generate new token**。可直接打开 [创建 fine-grained token](https://github.com/settings/personal-access-tokens/new)；现有令牌列表在 [Fine-grained tokens](https://github.com/settings/personal-access-tokens)。
4. 如 GitHub 要求确认密码、2FA、验证邮箱或组织 SSO，在 GitHub 页面完成，不要把验证码或令牌发到聊天。

### 2.2 每一项怎么填

以触发 `yidu456/AgentRouter-Check-in` 为例；使用自己的 Fork 时替换 owner 和仓库。

| 创建页字段 | 建议填写 | 为什么 |
| --- | --- | --- |
| Token name | `agentrouter-cloudflare-trigger` | 以后容易识别用途和轮换 |
| Description | `Cloudflare triggers AgentRouter Checkin workflow` | 只写用途，不写任何 Secret |
| Expiration | 选择有限有效期，例如 30 或 90 天，并记录到期日 | 按组织上限调整；过期后自动触发会失败，不建议为了省事永久有效 |
| Resource owner | `yidu456`，或你的目标仓库所属用户 / 组织 | Token 只能访问所选 owner 的资源；不是选择 Cloudflare 账号 |
| Repository access | **Only select repositories** | 不选 All repositories |
| Selected repositories | 仅选择 `AgentRouter-Check-in` 这个目标签到仓库 | 不是只选择按钮克隆出来的触发器仓库 |
| Repository permissions → Actions | **Read and write** | `workflow_dispatch` 需要 `Actions: write`；只有 Read 不够 |
| Metadata | 保留 GitHub 自动附带的 Read-only | 元数据只读，不需扩大 |
| Contents / Workflows / Administration / Secrets / Organization permissions | 本方案不额外开启 | 我们只触发工作流，不修改源码、工作流或读取仓库 Secrets |

点击 **Generate token**，将真实 Token 临时复制到剪贴板，随后按第 3 节存入 Cloudflare Secret。GitHub 生成后的完整值通常只显示一次，之后不能靠令牌列表找回原值；忘记时重新生成并轮换，不要尝试从构建日志找回。

Fine-grained PAT 当前不支持“另一个用户个人仓库的协作者”和“组织外部协作者”这两类访问。即使账号 B 对账号 A 的个人仓库有写权限，B 也不能因此选择 A 为 Resource owner；应由 A 创建限定该仓库的 PAT。组织目标的创建者应是组织正式成员，而非仅 outside collaborator，再满足仓库权限和审批要求。

权限不是“只允许这个工作流的启动”：`Actions: write` 还可能操作所选仓库其他 Actions 资源。限制仓库范围、有效期和保管位置很重要。

### 2.3 多个 GitHub 账号与组织仓库

- 账号 A 的仓库创建 Token A，账号 B 的仓库创建 Token B，分别保存为 `GITHUB_TOKEN_A`、`GITHUB_TOKEN_B`。不要用一个个人全仓库 Token 覆盖所有账号。
- Fine-grained PAT 的 **Resource owner** 只能选一个 owner。多个不同 owner 的目标不能靠同一个 Token 自动获得权限；分别创建获授权的凭据。
- 若同一 owner 下配置多个目标，仍推荐逐仓库限定令牌。一个 Token 授权多个选定仓库虽可行，但泄露时影响范围也会扩大。
- 组织可能禁止 fine-grained PAT、限制有效期、要求 SSO 或管理员批准。Token 标记为 **pending** 时，不要当作已能触发私有仓库；先由组织管理员批准。
- Token 不会提升持有者原有权限。看不到组织 / 目标仓库时，检查登录账号、组织正式成员资格、仓库权限和组织政策；仅作为另一用户仓库协作者或组织外部协作者的情形，不是开启更多权限就能解决。

## 3. 保存到 Cloudflare 运行时 Secrets

1. 打开 **Workers & Pages → `agentrouter-trigger` → Settings → Variables & Secrets**。
2. 点击 **Add**，选择 **Secret**，名称填写 `GITHUB_TOKEN_A`，值粘贴 Token A 的**完整原值**。
3. 保存，按页面提示点击 **Deploy** / 发布使配置生效。不要把值加上 JSON 引号，也不要复制 `Bearer ` 前缀或换行。
4. 另一个账号同样创建 Secret `GITHUB_TOKEN_B`，保存 Token B。
5. 再添加 **Text / Plaintext** 变量 `TRIGGER_CONFIG`，粘贴下面完整 JSON 文本，先保持 `enabled: false`。不要选择 JSON 对象绑定类型，脚本期待的是字符串。

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

只有一个目标时删除第二个对象。名称严格匹配且区分大小写：`token_secret: "GITHUB_TOKEN_A"` 表示读取该名称的 Worker Secret，**不是把真实 Token 写进 JSON**。

**不要放错位置：** Build variables and secrets 只供构建使用，定时 Worker 读不到它们；GitHub Actions Secrets 里的同名变量也不会自动传给 Worker。Cloudflare 的 `GITHUB_TOKEN_A` 不是 GitHub Actions 自动生成的临时 `GITHUB_TOKEN`。

后续 `keep_vars: true` 保留面板的普通变量，Wrangler 部署也不会删除已有 Secrets。保留不等于备份；不要因为重新部署而假定目标已经停用。

## 可选：企业微信 Webhook Secret

企业微信群 → 创建普通群机器人 → 复制 Webhook；在 Worker 的运行时 **Variables & Secrets** 添加 **Secret** `WECOM_WEBHOOK_URL` 并发布。URL 必须是完整的 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`，仅支持该官方主机和单个 key 参数。

这不是 GitHub PAT，也不是 Cloudflare build token；只用于 Cloudflare 调度结果通知。鉴权后的管理概况显示未配置、格式不合法或已配置，但不会请求机器人验证。不要把 Webhook 写进 JSON、日志、截图或聊天；已有 GitHub 最终签到通知不受这个可选设置影响。

## 4. Cloudflare 构建页 API token 怎么处理

### 4.1 推荐：让 Workers Builds 自动创建

1. 在连接 GitHub / 创建 Worker 的构建设置中找到 **API token**。已有 Worker 进入 **Settings → Build / Builds** 的相应设置。
2. 选择 **Create new token**，或使用已经给这个 Worker 构建配置好的有效 Token。Cloudflare 会创建部署用 API token，并用于后续构建上传。
3. 核对选中的 Cloudflare 账号和 Worker。该字段不应填写 GitHub PAT，也不是要求创建 `GITHUB_TOKEN_A`。
4. 若无法创建、选择或访问 Token，检查当前 Cloudflare 成员的部署和令牌管理权限，必要时请账户管理员配置。

当前官方说明中，自动创建的 Token 包括 Account Settings read、Workers Scripts edit、KV/R2 edit、账户各 zone 的 Workers Routes edit，以及 User Details / Memberships read。**它不是只授权一个签到请求的最小凭据**。在 Cloudflare **My Profile → API Tokens** 核对权限和范围，不要把自动创建说成没有其他权限；若范围不符合你的管理要求，采用组织批准的自定义 Token。

本项目没有 KV、R2 或域名路由，也不要求注册域名。不要额外授予 DNS edit 或提供 Global API Key。

### 4.2 必须手工创建部署 Token 时

1. 打开 [Cloudflare 用户 API Tokens](https://dash.cloudflare.com/profile/api-tokens)，选择 **Create Token**。
2. 选择官方 **Edit Cloudflare Workers** 模板，填写用途名称，例如 `agentrouter-trigger-build`。
3. 核对模板列出的权限和资源范围，把 account 范围限制为你要部署的那个 Cloudflare 账号；不要默认为你所有账号授予权限。按组织要求进一步收紧未使用资源，具体权限以当前平台模板及部署接口要求为准。
4. 配置合理有效期，检查 **Continue to summary** 摘要后再创建，将原值保存在秘密管理位置。不要贴到仓库、JSON、聊天或截图。
5. 在 Worker 的 Build 设置里选择该用户 Token 作为部署凭据。当前 Workers Builds 的 API token 文档说明只支持**用户 Token**；不要直接把 Account API Token 当成已支持的 build token。
6. 失败时区分“构建部署凭据失效”和“运行时 GitHub PAT 失效”：前者导致上传失败，后者导致 `DISPATCH_HTTP_401/403`，不是同一个问题。

此处不声称自定义最小权限组合已经在你的账户实测。模板、组织政策和平台权限名称可能变化；不要为了排错开启全账号权限。对于本项目，优先走面板管理的 Workers Builds，不需要自己调用 Builds 管理 REST API，也不需要另建 `Workers Builds Configuration` 管理 Token。

## 5. 启用前检查，不用真实 dispatch 验证令牌

1. 在 GitHub Token 列表核对 Resource owner、Selected repositories、Actions Read and write、有效期及组织审批。这是配置检查，不是成功触发证明。
2. 在目标签到仓库确认 `.github/workflows/Checkin.yml` 已在默认分支注册，并声明 `workflow_dispatch`；`main` 中也要有可运行的对应工作流。
3. 在 Cloudflare 核对 Secret 的**名称和类型**，以及 JSON 的 `repository`、`workflow`、`ref`、`token_secret`。不要把 Token 值复制出来检查或截图。
4. 另行确认并关闭默认分支旧的 `on.schedule`，保留 `workflow_dispatch`。不要在 Actions 界面禁用整个工作流。
5. 在明确允许真实签到后，在管理页开启所需目标；已有数据库开关时，改 JSON `enabled` 不会覆盖它。没有数据库覆盖时可把 JSON 设为 `enabled: true` 并发布，等待北京时间 00:05 初始化 Cron；管理页开启则会按时间规则建立/恢复日程。两者都不会立即签到，手动运行需另外点击确认。

仅做读取工作流的 API 检查，即使返回 200，也不能证明 Token 有 dispatch 写权限。不要用真实 `POST .../dispatches` 当作无副作用的连通性测试；它会启动真实工作流、登录并可能发送通知。

## 6. 到期、轮换与泄露处理

- 到期前用同样的 owner、仓库和权限生成新 PAT，更新同名 Cloudflare Secret 并发布，确认配置生效后撤销旧 Token。记录轮换操作，不把 Token 原值写进记录。
- 单纯更换同名 Secret 的值，不需要改目标 `id`、`repository`、`ref` 或重置存储，也不应重新抽取已经保存的日期目标。
- 若怀疑泄露，先在 GitHub 立即撤销泄露的 Token，再停用相应 Worker 目标并生成替代凭据；已发出的 HTTP / Actions 运行不会被撤销 Token 自动取消。
- Cloudflare build token 到期时，更新 Build 设置中的部署 Token；不要把新的 Cloudflare Token 写到 GitHub运行时 Secret。
- 不把令牌写进 URL、命令参数、JSON 配置、README、日志或截图；不要使用 `echo` 输出它检查。需要协助时只提供脱敏的字段名称、错误码和构建分支。

## 7. 常见现象对照

| 现象 | 优先检查 | 不要做什么 |
| --- | --- | --- |
| 构建上传认证失败 / Cloudflare API token invalid | Build 设置中的 Cloudflare 部署 Token、账号范围、成员权限、有效期 | 不要换 GitHub PAT，也不要开启全部权限 |
| `TOKEN_MISSING` | 运行时 Secret 是否存在、名称大小写、有没有引号/空白/`Bearer ` 前缀，是否误放 Build secrets | 不要把原值打印出来 |
| `DISPATCH_HTTP_401` | GitHub PAT 到期、撤销、复制不完整、使用了 Cloudflare Token | 不要盲目补发 dispatch |
| `DISPATCH_HTTP_403` | Actions 写权限、持有者权限、组织审批/政策，以及可能的 GitHub 限流 | 不要直接改用全仓库管理员权限 |
| `DISPATCH_HTTP_404` | Token 的 owner / 选定仓库、私有仓库访问权、`Checkin.yml` 名称和默认分支注册 | 404 不一定表示仓库真的不存在 |
| `DISPATCH_HTTP_422` | `ref` 是否存在、对应工作流是否能手动触发、是否另有必填 inputs | 不要只改 Cloudflare Production branch |
| 保存 Token 后没有运行 | 管理页有效开关（不能只看 JSON `enabled`）、运行时配置是否已发布、日程是否已初始化 | 不要把安全默认停用或等待日程当作 Token 创建失败 |
| `DISPATCH_UNKNOWN` | 到目标仓库 Actions 核对是否已启动，再人工决定是否补跑 | 不要因超时立即重发，可能已送达 |

返回 [部署、分支与完整配置指南](README.md)。

官方参考：[GitHub PAT 管理与创建](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[GitHub workflow dispatch 权限](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[Workers Builds API token](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)、[Cloudflare API Token 创建](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)。
