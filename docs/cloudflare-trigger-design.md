# Cloudflare 随机触发设计（待实施，不是已部署功能）

## 目标与边界

Cloudflare 只调度，登录仍在 GitHub 的 Ubuntu、Windows、macOS runner 上执行。每天在北京时间 01:00～23:00 随机选一个分钟级目标时刻，到点启动 `dev-plus` 的 `Checkin.yml`。不让 Actions 提前启动睡眠，不增加 Actions 轮询任务，不迁移浏览器或 Xray。

此文件是供确认的独立触发器设计。不会因文档提交而自动部署、触发真实签到、改默认分支或启用日程。

## 结构

1. 一个 Worker 接收 Cloudflare 的定时事件，使用稳定名称访问一个 SQLite Durable Object。
2. Durable Object 保存当前自动日程的日期、随机目标 UTC 时间戳、尝试状态和安全结果码，并用 `setAlarm(timestamp)` 注册未来执行。不在内存中 `sleep`，也不提前启动 GitHub runner。
3. Alarm 到点调用 GitHub REST 的 `workflow_dispatch` 接口，只传仓库、工作流、目标分支，不传签到 Secret。
4. 当前尝试结束后安排下一天目标。每日低频 Cron 只负责首次初始化和修复缺失日程，不重抽已经保存的当天目标。
5. Worker 不暴露公共触发/执行接口，普通 HTTP 请求返回 404；检查状态通过 Cloudflare 管理界面的安全日志和对象状态，不增加公开管理密钥。

## 时间规则

- 时区固定为 `Asia/Shanghai`，不是服务器本地时区；目标按本地日历日期生成，统一转换成 UTC 时间戳保存。
- 从 01:00 到 23:00（包含端点）的 1321 个分钟中随机选一个。随机可以偶然重复前一天的分钟，不宣称每个日期必然唯一。
- 日程保存后，重复 Cron、重部署和 Alarm 重试不能再次抽取该日目标。
- 初始化 Cron 建议为北京时间 00:05，即 UTC 16:05。若首次启用时当天窗口已开始，不突然补跑，安排下一天；实际实施需用本地测试覆盖初始化和修复边界。
- Cloudflare 调度延迟、网络和 GitHub 排队都可能推迟实际启动；目标窗口不是绝对准点保证。
- 手动 Actions 运行仍立即执行，不计入 Cloudflare 的自动触发标记；现有全分支并发锁继续避免同时登录。

## 防重复与失败取舍

Alarm 是至少一次交付，不能直接把每次回调都当成一次新签到。在持久状态中先记录该日期已经尝试，再发送触发请求，并保存成功/失败/不确定结果。

- 本设计偏向避免重复：每个自动日期最多一次触发请求尝试。
- 网络超时或连接中断时，不能断言 GitHub 没收到请求，因此不盲目重发，记录 `DISPATCH_UNKNOWN`，由用户核对 Actions 后决定是否手动运行。
- 明确拒绝或配置错误记安全错误码，不打印令牌、响应正文或例外详情。没有启动的 GitHub 工作流也没有最终机器人报告；触发故障需在 Cloudflare/GitHub 管理界面检查。
- 不能同时保证网络故障下“绝对不重复”和“绝对每天必跑”。如以后要求自动补偿，需要额外设计服务端幂等校验，不能偷偷增加 Actions 检查任务。

## 配置与凭据

触发器单独配置公开调度元数据：仓库 `yidu456/AgentRouter-Check-in`、工作流 `Checkin.yml`、分支 `dev-plus`、时间窗口。唯一必要业务凭据是只授权此仓库的 fine-grained GitHub PAT，授予 `Actions: write`，作为 Worker Secret 配置，不放代码、日志或聊天。该权限不是“只允许单个工作流触发”，还可能管理此仓库其他 Actions 资源；不要使用跨仓库广泛权限的令牌。

调用地址固定为 GitHub 官方 API 的 `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`，请求体仅含 `ref`。兼容官方接口版本的 HTTP 200/204 成功响应，不因旧版返回空正文而重试。工作流必须配置 `workflow_dispatch` 且已在默认分支注册；目标分支的改动不等于注册了新工作流。

账号凭据、代理订阅、机器人密钥仍只在 GitHub 的 `CHECKIN_CONFIG`。Worker 不读取这些内容。部署和令牌设置由用户完成或另行授权，不自动提取本机 GitHub/Cloudflare 凭据。

默认部署为未启用状态；缺少令牌或未明确启用时，定时事件不能发起 GitHub 请求。启用开关、日程状态和首次启用规则需要在实现时纳入测试。

## 正式启用步骤

1. 实现并运行不联网的时钟/状态/HTTP 模拟测试，确认不会重复触发，不会在配置非法时启动。
2. 部署未启用的 Worker，配置仓库限定的令牌，核对账户允许的 Durable Object SQLite 和额度。
3. **另行确认并停掉默认分支的原 `on.schedule`，保留 `workflow_dispatch`。** 不能在 Actions 界面禁用整个工作流，否则外部触发也不可用。不会通过推送 `dev-plus` 假装已关闭默认分支定时任务。
4. 在用户明确允许真实触发后，先验证一次触发，再启用自动日程。没有该许可就不进行验证调用或自动启用。
5. 回滚时先停用外部触发器，再恢复原定时入口，避免两个入口同时自动运行。

## 验收与费用

测试需覆盖北京时间日期边界、分钟上下限、首次启用、重部署、重复 Alarm、HTTP 2xx/4xx/5xx/超时、缺失令牌、停用状态、保守去重以及日志脱敏。全部 HTTP 请求使用模拟，不读取真实签到账户。

触发器不运行浏览器或容器，仅有少量 Worker/Alarm/存储操作；不会消耗 Actions 等待分钟。但 Cloudflare 仍有自己的产品配额和计费，应按账户套餐核对，不承诺永久零费用。

参考：[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Durable Object Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[GitHub 工作流触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
