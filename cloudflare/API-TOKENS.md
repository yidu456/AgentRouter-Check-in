# GitHub / Cloudflare 令牌指南

三种凭据不能混用：**GitHub PAT 启动 Actions；Cloudflare build token 部署 Worker；ADMIN_PASSWORD 登录管理页**。连接 GitHub 部署不等于授权运行 Actions。

## 1. 创建 GitHub PAT

1. 登录拥有目标签到仓库访问权的 GitHub 账号。
2. 打开 [Fine-grained tokens](https://github.com/settings/personal-access-tokens) → **Generate new token**。
3. 填写名称，如 `agentrouter-trigger`，设置合理有效期；到期前轮换。
4. **Resource owner** 选择目标仓库所属个人或组织。
5. **Repository access → Only select repositories**，只选择需要触发的仓库。
6. **Repository permissions → Actions → Read and write**；Metadata 的只读权限由 GitHub 自动附带。不需要为了本项目增加 Contents write。
7. 创建并保存原值。组织若要求审批，等待批准并按组织要求完成 SSO/策略授权。

一个 Fine-grained PAT 只能有一个 Resource owner；不同 owner 分别创建 Token。同一 owner 的多个已选仓库可共用一个 PAT。持有者本身也必须有相应仓库权限。

工作流须在目标仓库默认分支注册 `workflow_dispatch`；`ref` 指向存在且含工作流的可运行分支/标签。不要将 dispatch 写请求当成无副作用的测试，它会真实登录并可能通知。

## 2. 保存到 Worker 运行时

1. Cloudflare **Workers & Pages → 你的 Worker → Settings → Variables & Secrets → Add**。
2. 类型选 **Secret**，名称 `GITHUB_TOKEN_A`，粘贴 PAT 原值；不要加引号、换行或 `Bearer ` 前缀。
3. 其他 owner 的 PAT 保存为 `GITHUB_TOKEN_B` 等。
4. 保存并部署，然后登录管理页 → **新增目标**，填写仓库、分支和工作流，从凭据列表选择对应 Secret 名称，设置排期并保存。步骤见 [部署指南](README.md#3-配置仓库目标)。
5. 初次核对可先关闭“允许运行”，确认后开启。旧部署的 **Text** `TRIGGER_CONFIG` 仅用于首次导入，可选；已有数据库目录后不再修改它。

这是 **运行时** 设置，不是 Build variables，也不是 GitHub Actions Secrets；这些位置不会自动互通。`GITHUB_TOKEN_A` 也不是 Actions 自动生成的临时 `GITHUB_TOKEN`。

管理页另配 Text `ADMIN_USERNAME`、Secret `ADMIN_PASSWORD`、Secret `DEBUG_ACCESS_TOKEN`。入口值只决定路径，不用作 PAT 或登录密码。企业微信可另配 Secret `WECOM_WEBHOOK_URL`，不要写进仓库配置。

## 3. Cloudflare build token

**推荐**：Workers Builds 的 API token 设置中选择 **Create new token**，由平台为构建部署配置凭据；核对账号和 Worker。

必须手工创建时：

1. 打开 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token。
2. 使用 **Edit Cloudflare Workers** 模板，将账号范围限制到实际部署账号，核对模板权限及组织政策。
3. 设置有效期，检查摘要后创建。在 Worker 的 **Settings → Build / Builds** 选择该部署用用户 Token。
4. 如果无法创建/选择，检查成员的部署和令牌管理权限，必要时请管理员配置。

自动模板可能包含账户读取、KV/R2、Routes 等超出本项目实际使用的权限；不要声称它是单仓库最小令牌。进一步收紧需符合当前部署接口和组织政策。本项目不需要 DNS edit、Global API Key 或额外 Builds REST 管理令牌。不要把 GitHub PAT 填到这个框，也不要把 Cloudflare token 填进 `GITHUB_TOKEN_A`。

## 4. 轮换与排错

| 错误 | 先检查 |
| --- | --- |
| 构建上传认证失败 | Cloudflare build token、账号范围、成员权限、有效期 |
| `TOKEN_MISSING` | Worker 运行时 Secret 名称/类型、原值格式、是否保存部署 |
| `DISPATCH_HTTP_401` | PAT 过期、撤销、复制不完整或混用 Token |
| `DISPATCH_HTTP_403` | Actions 写权限、持有者权限、组织审批/政策或限流 |
| `DISPATCH_HTTP_404` | owner/repo、工作流文件名、默认分支注册、实际 ref、PAT 可见仓库 |

轮换时更新同名 Secret，保存部署后撤销旧 Token；不要更换目标 ID 或重置数据库。泄露则立即撤销泄露的凭据并停用目标，已启动的 Actions 不会自动取消。

不要把真实 Token、管理路径或密码写进 README、JSON 示例、截图、通知或聊天。需要排错只提供脱敏错误码、字段名称、构建分支及 commit SHA。
