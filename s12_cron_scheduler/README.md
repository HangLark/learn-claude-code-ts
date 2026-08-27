# s12: Cron Scheduler — 按时间交付 Prompt

> 调度器决定何时开始一轮 Agent 工作，而不是如何在后台执行一条命令。

s12 保存五段式 cron 表达式与待执行 prompt，支持 `*`、`*/N`、单值、范围和列表。调度器每秒按本地时间检查一次；同一任务在同一分钟只会入队一次，Agent 空闲后收到 `[Scheduled] ...` 用户消息。

任务包含 `recurring` 和 `durable` 两个维度。durable 任务原子写入 `.scheduled_tasks.json`，重启后恢复；session 任务只存在于内存。一次性任务成功交付后删除，周期任务则清除待交付状态，等待下次匹配。

到期任务会先持久化 `pendingDelivery` 再入队。只有模型成功接收 prompt 后才确认；模型调用或确认失败时任务回到队列，因此交付语义是“至少一次”。定时回合与用户回合串行执行，且定时回合不能发起交互式权限确认。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s12
```

让模型每两分钟调度一次 `run date`，再列出并取消该任务。观察 `.scheduled_tasks.json` 和到期后的 `[Scheduled]` 消息。进程退出后调度器停止，不会补跑停机期间错过的时间点。

s13 会让 Lead Agent 把工作分发给多个独立队友。
