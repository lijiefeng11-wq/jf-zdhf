# 后台排错日志

启动后台后自动写入 `<data-dir>/logs/backend.jsonl`。普通 CLI 入口默认数据目录为 `var/data`；service/launchd 使用显式指定的绝对 `--data-dir`。
每行一条 JSON，时间为带时区的 UTC；当前文件到 5 MiB 时轮转，最多保留 3 份旧文件。
日志只在本地保存，不提交 Git。日志清理不影响 SQLite 中的任务及 unknown 记录。

- `request_finished`：请求关联号、方法、隐藏标识符后的路由、HTTP 状态、耗时。
- `request_rejected`：接口拒绝的具体错误码，例如身份失效或参数错误。
- `event_snapshot`：接口返回的任务状态和发送状态；这只是后台所存回执，不额外证明平台成功。
- `decision_started/decision_finished`：后台判断开始与结束、动作和原因类别。
- `model_attempt/model_failed/model_succeeded`：主/备槽位（`slot`）、模型名（`model`）、故障码、耗时和备用是否成功。带回复期限的任务在子进程中调用模型，记录经管道交回后台写入，带同一 `event_ref`；被期限截断的调用至少留下 `model_attempt`。
- `model_test`：管理员连接测试结果，不记录模型返回原文。
- `request_internal_error/decision_internal_error/worker_stopped_unexpectedly`：异常类型及文件名、函数名、行号；最后一种表示工作线程已停止，需排查服务，不能靠 health=ok 判断任务处理正常。
- `service_started/service_stopped`：服务生命周期。

同一请求按 `request_id` 查询。同一任务按 `event_ref` 查询：对 UTF-8 编码的紧凑 JSON 数组 `[shop_id,event_id]`（不转义非 ASCII 字符）计算 SHA-256，取十六进制前 24 位。前台可用 `JSON.stringify([shop_id,event_id])` 计算相同值。标识摘要用于关联，不意味着不可逆匿名化。

日志不写凭据、请求/响应正文、完整买家聊天、图片、URL、模型回复或解释、核查备注、异常消息或局部变量。排错时用关联号定位任务，再由已授权管理界面查看必要信息。日志写入失败不改变任务/发送结果；磁盘故障需同时查看进程标准错误。

本功能不重试发送、不更改 unknown、不自动解锁或修改判断规则。尚未合并或部署的源码不会改变正在运行的服务。
