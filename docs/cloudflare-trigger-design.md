# Cloudflare 触发器结构

使用步骤见 [部署指南](../cloudflare/README.md)，凭据见 [令牌指南](../cloudflare/API-TOKENS.md)。本页仅说明实现边界。

## 职责

- Worker：读取 TRIGGER_CONFIG，提供隐藏入口和鉴权管理 API；Cron 每天北京时间 00:05 初始化目标。
- 每目标一个 SQLite Durable Object：持久化开关、随机日程、最多20条调度日志及24小时手动请求回执；不是每天创建一个对象。
- Alarm：各目标各日期独立抽取01:00～23:00时间，到点向GitHub workflow_dispatch提交一次请求。
- GitHub Actions：运行真实Ubuntu/macOS/Windows浏览器与Xray，负责签到及最终余额汇总。

## 管理和认证

`/`仅hello world；`/<DEBUG_ACCESS_TOKEN实际值>`是用户名密码登录页。登录使用ADMIN_USERNAME/ADMIN_PASSWORD，每个私有请求独立校验HTTPS Basic；旧Bearer入口凭据和fragment不再登录。只在页面内存保存凭据，退出清空。入口路径不是认证，仍可能被历史和访问日志记录。

三栏分离：仓库操作/下一次时间；配置存在性、错误字段与修复建议；按仓库分类的调度日志，区分工作流/ref/id。页面读取不创建日程或提交任务。

## 数据与副作用

新JSON目标默认enabled:true；明确false保持关闭，数据库匹配的开关优先。目标身份使用id和repository/workflow/ref匹配，更新PAT原值不改变日程。

自动调度在HTTP前持久化attempted，未知结果不补发。手动UUID回执24小时、最多100条，新请求间隔30秒；原UUID重试不创建新业务请求。删除可见日志不删除回执、日程、开关或Alarm。

管理重新开启只恢复未来可用计划，错过日程跳过；重复enabled:true不跳过普通延迟Alarm。来源校验、受限JSON请求体、私有认证、输出脱敏、无重定向和故障保守处理贯穿操作。

Worker机器人结果只说明GitHub是否受理调度，不是最终签到成功。GitHub最终结果仍单独汇总。若旧GitHubCron未关闭，会出现两套触发来源；不自动删除用户工作流。
