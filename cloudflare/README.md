# Cloudflare 定时调度与管理

Cloudflare 负责定时触发，GitHub Actions 负责浏览器登录、Xray 代理和最终签到通知。支持每个目标每天 **1～24 次**固定时间或窗口内独立随机；省略排期默认每天一次、北京时间 **01:00～23:00** 随机。Actions 不启动后等待，一个 Worker 支持多个仓库及不同 GitHub 账号。

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
      "token_secret": "GITHUB_TOKEN_A",
      "schedule": {"mode": "fixed", "times": ["08:30", "13:00", "20:30"]}
    },
    {
      "id": "backup",
      "repository": "another-owner/AgentRouter-Check-in",
      "workflow": "Checkin.yml",
      "ref": "main",
      "token_secret": "GITHUB_TOKEN_B",
      "enabled": false,
      "schedule": {"mode": "random", "count": 3, "window": {"start": "09:00", "end": "22:00"}}
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
| `schedule` | 可选初值；固定模式填 `mode`/`times`，随机模式填 `mode`/`count`/`window`；两者可填 `min_interval_minutes` |

同一仓库、工作流和 ref 不能重复配置。未知字段被拒绝；JSON 不支持注释。管理登录、webhook、配置和数据库绑定名称不得用作 `token_secret`。

**排期填写规则**：所有时间使用 `Asia/Shanghai`，严格为 `HH:mm`（00:00～23:59）。固定 `times` 为 1～24 个不重复时间，顺序不限，次数就是列表长度。随机 `count` 为整数 1～24，窗口包含两端，不跨日，次数不能超过窗口的可用分钟数；例如 09:00～09:01 最多两次。省略 `schedule` 保留旧版每天一次及已有随机时间。这里的次数是计划触发次数，不是签到成功次数。

`min_interval_minutes` 为整数 1～1440，省略默认 1。固定时间需满足相邻时间及最后一次到次日第一次的间隔；随机次数需同时满足窗口容量与每天间隔。例如 09:00～10:00、间隔 60 分钟最多两次，不能设置三次。完整例子：

```json
{"mode":"random","count":3,"window":{"start":"09:00","end":"22:00"},"min_interval_minutes":120}
```

**开关以数据库保存值优先**：旧目标明确关闭，不会因更新源码、重部署或 JSON 默认开启而被重置。保持 `id`、仓库、工作流和分支稳定；更换目标身份会使旧开关和日程失去匹配。换同名 PAT 的值不改变身份。

Cloudflare 的 Production branch 决定部署源码；`ref` 决定运行 Actions，两者互不替代。目标工作流须在仓库默认分支声明 `workflow_dispatch`。

## 4. 打开管理页

从 **Domains & Routes** 复制实际 HTTPS 域名：

- `/` 只显示 `hello world`。
- `/<DEBUG_ACCESS_TOKEN 的实际值>` 打开用户名密码登录页；不是固定 `/token`。
- 入口配置缺失或不合法时返回 404；用户名密码未配置时登录页明确提示，不提供默认密码。
- 登录后有 **仓库管理 / 配置检查 / 运行日志** 三栏。主页放开关、手动运行、下次时间及已保存时段；配置栏用四张状态卡、逐目标表格及高亮错误字段展示检查结果，技术状态折叠；日志按仓库分类。
- 首次登录管理页时，为已开启且 Token 有效、尚无排期的目标保存未来日程，无需关闭再开启。刷新保留原时间；未来 Alarm 若缺失，可按原时间恢复，不立即触发 GitHub。手动运行需要确认，不占用自动时段。

浏览器只在登录时提交 HTTPS Basic 凭据，随后清空输入；安全 Cookie（Secure、HttpOnly、SameSite=Strict）固定有效 **12 小时**，刷新、离开后返回可恢复，不会自动续期。页面不保存密码到浏览器存储；写操作校验同源和 CSRF。退出管理会撤销当前会话，其他设备的会话不受影响；退出失败会明确提示，刷新可能恢复。修改管理员用户名、密码或入口值会使旧会话失效。每个 Worker 最多 128 个未过期会话，达到上限可退出其他会话或等待到期；无需新增 Secret。

私有 API（包括 `/health`）仍兼容正确的 Basic 请求，浏览器使用会话 Cookie。隐藏入口没有 Token fragment 快捷登录。

隐藏路径仍可能出现在历史记录和访问日志，**不是认证防线**。不要分享真实路径或密码；曾公开的入口值应轮换。使用强随机密码，公网入口建议用 Cloudflare Access/WAF 再限制访问。

### 在前端修改排期

1. 在“仓库管理”找到目标，展开“排期设置”。选择固定/随机；固定模式增删时间点，随机模式填写次数和窗口。
2. 填写最小间隔（分钟），点击“保存排期”。次数和间隔不可能同时满足时，页面给出原因，不会偷偷减少次数。
3. 查看来源和下一次时间。保存值存入该目标数据库，刷新、换设备、重部署后保留；保存不等于运行，也不会自动开启已关闭的目标。
4. 如需重新使用变量初值，点击“恢复变量配置”并确认。已有数据库覆盖优先于 `TRIGGER_CONFIG`，只修改变量不会覆盖它；配置检查页展示变量初值，目标卡片展示最终生效值。

保存前的草稿只在本页内存，普通刷新保留，重载/退出不保留。两个页面同时修改时，旧版本会提示冲突，请重新读取并确认设置，不自动覆盖。保存响应未知时先刷新核对实际来源、版本和时间，不盲目重复提交；设置可能已保存而 Alarm 暂未设置成功。

## 5. 调度、日志与通知

- 每目标每天保存固定或随机时段，一个 Alarm 指向下一时段，不增加轮询 Cron。随机时段在同一天不重复，目标和日期之间独立；GitHub 排队可能延迟。
- 首次固定排期保留今天未来时间，过去时间跳过；今天没有未来时间则排明天。首次随机排期在窗口开始前抽取今天，开始后抽取明天完整窗口。旧配置仍按 01:00 分界。目标关闭、Token 缺失/非法或配置/存储损坏时不初始化。
- 暂停后重新开启、修改排期不补发过期时段。Alarm 延迟跨过多个时段时只尝试最近一个，较早时段跳过；跨日期全部跳过。刷新不重新随机，首次 Alarm 保存失败后可恢复同一计划。
- 最小间隔只限制同一目标的**自动触发请求**，跨日、暂停/重开和删除日志不清除已确认的间隔基线。HTTP 失败/结果未知也计入间隔；未到间隔的时段显示“最小间隔未到，已跳过”，不补发或通知。手动运行仅保留 30 秒冷却，不改变自动基线。
- 最后一个时段结束后，页面仍显示带日期的“上次排期末时段”，保留其跳过原因；这只保留上一份排期的最后一个时段，不是完整历史审计。
- GitHub 排队后的实际开始间隔不由 Worker 保证。随机窗口限制计划时间，Alarm 可能延迟；配置次数是计划次数，实际尝试可能因延迟、间隔或故障减少。修改当天排期不撤回先前已提交请求，不是累计配额。
- 升级时仅从可信、身份匹配的旧自动记录恢复间隔基线；记录不存在/已删除时显示“未建立”，不能倒推出过去运行时间，下一次自动尝试建立基线。
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
| 无下次时间/目标关闭 | 查看数据库开关、PAT 和存储状态；有效开启目标首次打开管理页会初始化，或等待 00:05 |
| 刷新仍要求登录 | 核对 HTTPS、浏览器 Cookie 策略、12 小时是否到期，以及管理员/入口值是否变更 |
| `DISPATCH_HTTP_401/403/404` | 分别检查 PAT 有效性／权限审批／仓库工作流和 ref，不盲目补发 |
| 日志空白 | “暂无记录”和“读取失败”分别提示；只有发生调度才有记录，不会显示虚构任务 |
| 保存排期冲突 | 另一个页面或目标配置已更新；读取最新值再确认修改 |
| 保存结果未知 | 先刷新查看实际设置、版本和 Alarm 状态；不会自动重复保存或触发 |
| 最小间隔未到 | 自动时段已跳过；检查上次自动尝试、间隔与窗口，不代表签到失败 |

**升级与回退**：旧单时段计划迁移为 v2，保留原时间和已尝试状态，不清空开关、日志或防重复记录。没有前端覆盖且使用默认间隔时不会仅因升级重抽时间。旧代码不能保证读取 v2，也可能忽略新数据库排期和间隔；回退需兼容处理或先停用目标并确认 Alarm 停止，不能清空数据库“修复”。仅设置空 `targets` 不证明现有 Alarm 已删除。
