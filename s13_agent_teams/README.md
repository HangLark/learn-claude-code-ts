# s13: Agent Teams — 持久队友与协作协议

> Team 不是一次性 subagent：每个队友保留独立上下文，在 WORK 与 IDLE 之间循环，直到完成关机握手。

s13 把 s10 的持久任务图扩展为团队运行时：Lead 负责用户对话和分工，队友独立调用模型；双方通过 `.mailboxes/*.jsonl` 交换消息，绝不共享 messages 数组。队友返回的 `result` 与 `idle_notification` 是两个事件，运行时会自动唤醒 Lead，无需模型轮询。

空闲队友先读取收件箱，再扫描 ready task，并在单一任务存储 mutex 内认领；同一进程中只有一个队友能取得所有权。队友必须先认领任务才能使用文件和 Shell 工具，任务可选绑定 `.worktrees/<name>`，从而改变默认 cwd。worktree 不是沙箱，删除仍留给宿主或用户处理。

控制流使用带 request ID 的协议：

- `shutdown_request → shutdown_response` 让队友完成当前步骤后退出。
- `plan_approval_request → plan_approval_response` 驱动计划闸门；`required`、`pending`、`rejected` 状态会阻止 Bash、写入、编辑和任务完成。
- 每次任务身份改变都会使旧计划失效。

Lead 的 system prompt 要求先提出小团队并等待用户确认，确认后才可 `spawn_teammate`。本章不继承 s11 后台命令或 s12 定时器，只展示 Team 层。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s13
```

给出一个可并行拆分的需求，确认 Lead 的团队提议后，观察 `.tasks/`、`.mailboxes/` 和可选 `.worktrees/` 的状态变化。按 `Ctrl+C` 退出。

s14 会通过 MCP 在运行时发现外部工具。
