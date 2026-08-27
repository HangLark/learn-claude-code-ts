# s11: Background Tasks — 慢命令放到后台

> 后台执行先返回任务 ID；完成结果在后续轮次作为新事件进入对话。

s11 给 Bash 工具增加显式的 `run_in_background` 参数。只有模型把它设为 `true` 时，Harness 才启动后台子进程并立即返回 `bg_xxxx`；其他工具和 Bash 调用仍同步执行，不根据命令关键词猜测。

后台管理器记录 `running`、`completed`、`failed` 状态。每次调用模型前，Harness 收集已经完成的任务，生成独立的 `<task_notification>` 文本并追加到最近的 user message。原工具调用已经收到“任务已启动”的占位结果，因此完成通知不会再次使用原来的 `tool_use_id`。

Node 的子进程本身异步工作，不需要为这一机制额外模拟线程或锁。完成通知也不会主动唤醒已结束的 Agent Loop，只会在下一次进入循环时被收集。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s11
```

让模型在后台运行一个短暂的 `sleep`，同时读取 `package.json`；随后继续对话，观察 `bg_xxxx` 占位结果和 `<task_notification>`。按 `Ctrl+C` 退出。

s12 会在后台执行之上加入定时调度。
