# Cloudflare 随机触发设计与实现（尚未部署或启用）

## 目标与边界

Cloudflare 只调度，登录仍在 GitHub 的 Ubuntu、Windows、macOS runner 上执行。一个 Worker 支持多个 GitHub 账号下的多个仓库；每个目标（仓库、工作流、分支）每天在北京时间 01:00～23:00 独立随机选一个分钟级目标时刻，到点触发该目标。不让 Actions 提前启动睡眠，不增加 Actions 轮询任务，不迁移浏览器或 Xray。

实现位于 `cloudflare/`，运行时变量、Secrets、GitHub 连接部署和模板按钮详见 [部署手册](../cloudflare/README.md)。本地提交本身不部署；若用户已连接 Workers Builds，推送配置的生产分支可能自动构建并部署，并继续使用已有运行时变量和持久开关。推送不代表密钥已配置、签到已成功，也不修改仓库默认分支或旧 Cron。现有 IP 链接、国家和站点用户组通知已在 `9fec477` 独立交付。

## 结构

1. 一个 Worker 接收 Cloudflare 的每日定时事件，按目标的稳定 `id` 分别访问 SQLite Durable Object；每个目标一个对象，不为每个日期创建新对象。
2. Durable Object 保存当前自动日程的日期、随机目标 UTC 时间戳、尝试状态和安全结果码，并用 `setAlarm(timestamp)` 注册未来执行。不在内存中 `sleep`，也不提前启动 GitHub runner。
3. Alarm 到点调用 GitHub REST 的 `workflow_dispatch` 接口，只传仓库、工作流、目标分支，不传签到 Secret。
4. 当前尝试结束后安排该目标下一天的独立随机时间。每日低频 Cron 只负责各目标的首次初始化和修复缺失日程，不重抽已经保存的当天目标。一个目标配置或触发失败不阻止其他目标；分别保存结果和去重状态。
5. Worker 提供公开只读首页及 `/health`，检查本地 JSON、Secret 配置数量和初始启用状态，不展示敏感值、目标身份或读取日程；不调用外部服务。没有免鉴权触发/执行/配置写入接口。
6. 可选 Secret `WECOM_WEBHOOK_URL` 用于实际 dispatch 后的调度结果通知，持久记录通知尝试以避免重复；机器人失败不改变 GitHub 触发结果，也不增加轮询。账号最终签到报告仍由 GitHub 发送。
7. 可选独立 `DEBUG_ACCESS_TOKEN` 开启管理页，复用已有 SQLite 存储持久开关、日程、最近 20 条调度日志及手动回执。没有访问 Secret 时管理功能关闭，自动调度不受影响。`/#token=` 入口只把访问凭据留在页面内存，所有私人状态读取/操作需 Bearer 鉴权。详见 [获批管理设计](superpowers/specs/2026-11-07-trigger-admin-design.md)。

## 时间规则

- 时区固定为 `Asia/Shanghai`，不是服务器本地时区；目标按本地日历日期生成，统一转换成 UTC 时间戳保存。
- 从 01:00 到 23:00（包含端点）的 1321 个分钟中随机选一个。随机可以偶然重复前一天的分钟，不宣称每个日期必然唯一。
- 随机单位是“目标 × 北京时间日历日期”：每个日期使用新随机样本，不从前一天的时间加固定偏移；不同目标之间也分别抽取，不共享一天的统一时间。采用系统安全随机源进行均匀抽取。
- 独立随机允许不同目标或相邻日期恰好抽到相同时间，不增加排除重合、强制错开或全局排序规则。这些规则会改变独立随机的含义。
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

触发器通过 Cloudflare 运行时的 `TRIGGER_CONFIG` JSON 文本变量配置目标列表。北京时间窗口固定为 01:00～23:00，不引入额外时区或窗口选项。目标可以来自不同 GitHub 账号，但各自令牌必须获得相应仓库授权。这不是现有签到 `CHECKIN_CONFIG` 的新字段：

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

`id` 是唯一、稳定的调度标识；`repository` 为 `owner/repo`；`workflow` 为目标工作流文件名；`ref` 为目标分支；`token_secret` 只写 Worker Secret 的名称，绝不能填写令牌本身；`enabled` 是布尔型初始单目标开关，管理页保存后以匹配目标身份的数据库覆盖为准。禁止重复 `id` 和重复仓库/工作流/分支目标，避免同一配置中重复调度。移除或有效停用的目标即使还收到旧 Alarm 也不得发送请求。已有日程绑定目标身份，修改仓库/工作流/分支不能让旧 Alarm 悄悄触发新目标。

每个目标推荐配置只授权相应仓库的 fine-grained GitHub PAT，授予 `Actions: write`，作为 Worker Secret 保存，不放代码、JSON、日志或聊天。该权限不是“只允许单个工作流触发”，还可能管理此仓库其他 Actions 资源；不要为了支持多个 GitHub 账号使用跨仓库广泛权限的令牌。

调用地址固定为 GitHub 官方 API 的 `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`，请求体仅含 `ref`。兼容官方接口版本的 HTTP 200/204 成功响应，不因旧版返回空正文而重试。工作流必须配置 `workflow_dispatch` 且已在默认分支注册；目标分支的改动不等于注册了新工作流。

账号凭据、代理订阅、机器人密钥仍只在各自 GitHub 仓库的 `CHECKIN_CONFIG`。Worker 不读取这些内容，各仓库独立执行、独立最终通知，不做跨仓库统一签到汇总。部署和令牌设置由用户完成或另行授权，不自动提取本机 GitHub/Cloudflare 凭据。

默认部署为未启用状态；未配置变量时目标列表为空，缺少令牌或未明确启用时，定时事件不能发起 GitHub 请求。配置、启用开关、日程持久化、首次启用和失败隔离均有模拟测试。GitHub 请求使用 `redirect: manual`，不跟随任何重定向；Workers 不支持标准 Fetch 的 `error` 重定向模式。

## 正式启用步骤

1. 实现并运行不联网的时钟/状态/HTTP 模拟测试，确认不会重复触发，不会在配置非法时启动。
2. 部署未启用的 Worker，配置仓库限定的令牌，核对账户允许的 Durable Object SQLite 和额度。
3. **另行确认并停掉默认分支的原 `on.schedule`，保留 `workflow_dispatch`。** 不能在 Actions 界面禁用整个工作流，否则外部触发也不可用。不会通过推送 `main` 假装已关闭默认分支定时任务。
4. 在用户明确允许真实触发后，先验证一次触发，再启用自动日程。没有该许可就不进行验证调用或自动启用。
5. 回滚时先停用外部触发器，再恢复原定时入口，避免两个入口同时自动运行。

## 验收与费用

测试需覆盖北京时间日期边界、分钟上下限、各目标/日期分别取新样本且允许重合、首次启用、重部署、重复 Alarm、HTTP 2xx/4xx/5xx/超时、缺失令牌、停用/移除/修改目标、重复目标拒绝、目标间失败隔离、保守去重以及日志脱敏。全部 HTTP 请求使用模拟，不读取真实签到账户。

触发器不运行浏览器或容器，仅有少量 Worker/Alarm/存储操作；不会消耗 Actions 等待分钟。但 Cloudflare 仍有自己的产品配额和计费，应按账户套餐核对，不承诺永久零费用。

正常情况下每日一个共享 Worker Cron，各目标约一次初始化/检查调用及一次 Alarm；N 个目标约 2N 次对象调用/天，另加首次初始化、故障恢复或平台重试的调用。等待时不保留内存计时器或长连接；不是 N 个全天运行的进程。各 GitHub 账号仍按自身套餐承担实际工作流用量。

参考：[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Durable Object Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[GitHub 工作流触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
