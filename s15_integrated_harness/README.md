# s15：Integrated Harness

s15 不再引入单独机制，而是把前十四章的能力接入同一个 Agent 循环：

```text
用户 / cron / 后台任务 / 团队事件
  → 上下文压缩与实时 system prompt
  → 模型
  → hooks + 权限 + 工具分发
  → tool_result / task_notification
  → 回到同一循环
```

## 核心实现

- 每轮动态组装 26 个内置工具、已连接的 MCP 工具和后续章节注册的扩展工具。
- `todo`、一次性 subagent、技能、记忆、任务图、持久团队和 worktree 保持各自职责。
- cron、后台 Bash 和团队收件箱都能自动唤醒 Lead；durable cron 在模型调用成功前保持待投递。
- 所有 Shell 命令都需用户确认；异步轮次不能弹出确认，会直接拒绝需要授权的调用。
- 模型调用前统一控制上下文预算，并只在 429、529、`max_tokens` 和上下文过长这些协议边界执行恢复。
- `registerIntegratedTool()` 是刻意保留的扩展缝隙，s16 会通过它加入 `Workflow`，而不改写主循环。

代码仍以教学为目标：没有抽取跨章节共享库，也没有实现跨进程锁、完整进程沙箱或 worktree 自动删除。

## 运行

```sh
pnpm s15
```

可以尝试让 Agent 连接 `docs` MCP、安排提醒、后台运行 Bash，或在确认后组建团队。运行 Shell 前会出现交互确认。
