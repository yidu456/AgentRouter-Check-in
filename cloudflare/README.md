# Cloudflare 随机调度与管理

Cloudflare 负责定时触发，GitHub Actions 负责浏览器登录、Xray 代理和最终签到通知。每个仓库目标、每个北京时间日期独立随机选择 **01:00～23:00**；Actions 不启动后等待。一个 Worker 支持多个仓库及不同 GitHub 账号。

## 1. 连接 GitHub 部署

1. 将本项目同步到自己的 GitHub 仓库，确认 `main` 包含 `cloudflare/`。
2. Cloudflare **Workers & Pages → Create application → 导入 GitHub 仓库**，选择 Worker，不是 Pages。
3. 核对以下设置，保存并部署：

| 设置 | 值 |
| --- | --- |
| Worker 名称 | `agentrouter-trigger`，与 `wrangler.jsonc` 一致 |
| Production branch | `main` |
| Root directory | `cloudflare` |
| Build command | `npm test` |
| Deploy command | `npm run deploy` |
| Node.js | 22 或更新 |
| Preview builds | 关闭 |
| Build API token | 让 Workers Builds 创建部署 Token；不是 GitHub PAT |

已有 Worker 在 **Settings → Builds → Connect / Branch control** 核对仓库、分支和目录。保存后需要来自新提交的新构建；Retry 旧构建不会换成新源码。确认构建 commit SHA 和生产部署成功。

`SCHEDULES` SQLite Durable Object 和每天北京时间 00:05 的初始化 Cron 随配置创建，无需额外 D1。后续推送生产分支可自动部署；面板普通变量和 Secrets 保留。

也可使用 [部署按钮](https://deploy.workers.cloudflare.com/?url=https://github.com/yidu456/AgentRouter-Check-in/tree/main/cloudflare)。按钮只复制触发器到新仓库根目录，**Root directory 留空**，不复制签到脚本或账号配置，也不自动同步上游。

## 2. 设置运行时变量

进入 **Worker → Settings → Variables & Secrets**，不是 Build variables。每次修改后保存并部署。

| 名称 | 类型 | 填写方式 |
| --- | --- | --- |
| `TRIGGER_CONFIG` | Text | 下节完整 JSON 字符串 |
| `GITHUB_TOKEN_A` | Secret | GitHub Fine-grained PAT 原值，Actions Read and write |
| `DEBUG_ACCESS_TOKEN` | Secret | 随机 32～128 字符，只含字母、数字、`_`、`-`；作为隐藏入口路径 |
| `ADMIN_USERNAME` | Text | 1～64 字符，不含空白、冒号或控制字符 |
| `ADMIN_PASSWORD` | Secret | 独立强密码，12～256 字符，不含控制字符；不要复用入口值 |
| `WECOM_WEBHOOK_URL` | Secret，可选 | 企业微信群机器人完整官方 webhook URL |

GitHub 连接只允许构建源码，**不自动授权启动 Actions**；每个 GitHub owner 单独创建 PAT。详细步骤见 [令牌指南](API-TOKENS.md)。签到用 `CHECKIN_CONFIG` 仍配置在各目标仓库的 GitHub Actions Secrets，不放在 Worker。

## 3. 配置仓库目标

以下是虚构示例。新目标省略 `enabled` 默认开启；初次核对配置时可显式写 `false`，准备好后从管理页开启。

```json
{
  "version": 1,
  "targets": [
    {
      "id": "primary",
      "repository": "your-owner/AgentRouter-Check-in",
      "workflow": "Checkin.yml",
      "ref": "main",
      "token_secret": "GITHUB_TOKEN_A"
    },
    {
      "id": "backup",
      "repository": "another-owner/AgentRouter-Check-in",
      "workflow": "Checkin.yml",
      "ref": "main",
      "token_secret": "GITHUB_TOKEN_B",
      "enabled": false
    }
  ]
}
```

只有一个目标就删除第二个对象；多目标依次增加对象。

| 字段 | 规则 |
| --- | --- |
| `version` | 数字 `1` |
| `targets` | 数组，最多 100 个；空数组不调度 |
| `id` | 唯一、稳定；字母或数字开头，最多 64 个字母/数字/`_`/`-` |
| `repository` | `owner/repo`，不是完整 URL |
| `workflow` | 文件名，如 `Checkin.yml` 或 `checkin.yaml`，不包含目录 |
| `ref` | 实际分支或标签，例如 `main`、`dev-plus`；不能有 `..`、空白或末尾 `/` |
| `token_secret` | Worker Secret 名称，字母大写开头，最多 64 个大写字母/数字/`_`；不是令牌原值 |
| `enabled` | 可选布尔值，省略为 `true`；`false` 禁止自动和手动触发 |

同一仓库、工作流和 ref 不能重复配置。未知字段被拒绝；JSON 不支持注释。管理登录、webhook、配置和数据库绑定名称不得用作 `token_secret`。

**开关以数据库保存值优先**：旧目标明确关闭，不会因更新源码、重部署或 JSON 默认开启而被重置。保持 `id`、仓库、工作流和分支稳定；更换目标身份会使旧开关和日程失去匹配。换同名 PAT 的值不改变身份。

Cloudflare 的 Production branch 决定部署源码；`ref` 决定运行 Actions，两者互不替代。目标工作流须在仓库默认分支声明 `workflow_dispatch`。

## 4. 打开管理页

从 **Domains & Routes** 复制实际 HTTPS 域名：

- `/` 只显示 `hello world`。
- `/<DEBUG_ACCESS_TOKEN 的实际值>` 打开用户名密码登录页；不是固定 `/token`。
- 入口配置缺失或不合法时返回 404；用户名密码未配置时登录页明确提示，不提供默认密码。
- 登录后有 **仓库管理 / 配置检查 / 运行日志** 三栏。主页只放开关、手动运行、下次时间；配置栏显示 JSON 错误字段、修复建议及绑定状态；日志按仓库分类，再区分工作流、分支和目标 ID。
- 刷新只读取，不运行签到或补发。手动运行需要确认，不改变下一次自动日程。

私有 API（包括 `/health`）每次通过独立用户名密码鉴权；页面使用 HTTPS Basic 请求，凭据仅在本页内存，不使用 Cookie、浏览器存储或 Token fragment 快捷登录。退出、重载或离开页面后重新登录。

隐藏路径仍可能出现在历史记录和访问日志，**不是认证防线**。不要分享真实路径或密码；曾公开的入口值应轮换。使用强随机密码，公网入口建议用 Cloudflare Access/WAF 再限制访问。

## 5. 调度、日志与通知

- 每个目标每天一条随机日程；时间是数据库实际保存值，GitHub 排队可能延迟。已错过的日程不会因管理操作补发。
- “GitHub 已受理”仅表示触发请求被接受，不表示 Actions 完成或签到成功。最终余额汇总由 Actions 发送；Worker 企业微信只报告仓库、触发来源和调度结果。
- 每目标最近 20 条日志；单条删除或清空此目标需确认，不影响同仓库其他目标、日程、开关、防重复记录或平台日志。
- 手动请求 ID 保留 24 小时、最多 100 条，新请求间隔至少 30 秒；响应未知只重试原 ID，不创建新任务。自动请求不确定时不重复提交。
- 配置检查只验证本地格式/存在性，不假称 GitHub 权限、机器人或线上构建已验证。

**正式启用 Cloudflare 前，在每个目标仓库删除旧 `on.schedule`，保留 `workflow_dispatch`，否则可能重复签到。此项目不会替你删除旧 Cron。**

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 首页只有 hello world | 正常，使用实际入口值的路径登录 |
| 入口 404 | 核对运行时 Secret、字符长度、路径大小写，无末尾 `/`；确认最新生产部署 |
| 登录失败/不可用 | 核对 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 的名称、类型和规则，保存部署后重新登录 |
| JSON 错误 | 配置栏查看字段位置和建议，修正后保存部署 |
| Token 未配置 | 添加与 `token_secret` 完全同名的运行时 Secret |
| 无下次时间/目标关闭 | 查看数据库开关、PAT 和存储状态；未初始化时等待 00:05，或确认后开启目标 |
| `DISPATCH_HTTP_401/403/404` | 分别检查 PAT 有效性／权限审批／仓库工作流和 ref，不盲目补发 |
| 日志空白 | “暂无记录”和“读取失败”分别提示；只有发生调度才有记录，不会显示虚构任务 |

回退旧 JSON-only 调度版本前先停止目标（或设置空 `targets`）并确认原 Alarm 已停止；旧代码可能忽略数据库开关。不要清空数据库解决配置问题。
