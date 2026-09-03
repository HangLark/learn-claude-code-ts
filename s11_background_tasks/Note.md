# s11：Background Tasks

## 核心结论

后台 Bash 把一次工具调用拆成“立即确认已启动”和“以后交付完成事件”两次观察，使 Agent Loop 不必同步等待命令结束。

```text
后台工具观察 = 启动占位结果 + 后续完成通知
```

## 核心数据

后台任务用状态判别联合表示：

```ts
interface RunningTask {
  id: string;
  command: string;
  status: 'running';
}

interface FinishedTask {
  id: string;
  command: string;
  status: 'completed' | 'failed';
  result: string;
}

type BackgroundTask = RunningTask | FinishedTask;
```

`BackgroundManager.tasks` 保存仍由 Harness 跟踪的任务，`ready` 保存已经结束但尚未注入消息的完成事件。`id` 关联启动占位结果、运行状态和最终通知。

`run_in_background: true` 是模型在本次 Bash 调用中提供的事件数据；Harness 不从命令文本推断是否应该后台运行。

完成通知使用 s05 已展开的 `Anthropic.TextBlockParam`，而不是再次构造 `ToolResultBlockParam`，因为原工具调用已经收到过占位结果。

## 数据流

```text
bash(command, run_in_background=true)
  → 先经过 PreToolUse 权限检查
  → 分配 bg_id，保存 RunningTask
  → 异步启动子进程
  → 立即回填“已启动”的 tool_result

子进程结束
  → RunningTask 转为 FinishedTask
  → 进入 ready 队列

下一次模型调用前
  → collect() 取走全部 ready
  → 生成 <task_notification> TextBlockParam[]
  → 合并进最近的 user message
  → 删除已交付任务
```

子进程输出是外部观察；`FinishedTask` 是内部状态；XML 文本是供模型消费的派生事件表示。

## 关键约束

- 只有显式的 `run_in_background === true` 才改变执行方式。
- 权限检查必须发生在后台进程启动之前。
- 每个 `tool_use_id` 只对应最初的启动结果；完成通知不得重复使用它。
- `collect()` 必须具有取走语义，同一完成事件只能注入一次。
- 通知应附加到 user 角色消息，使异步外部观察仍沿用既有对话协议。
- 后台任务完成不会主动唤醒已经停止的 Agent Loop；结果只在下一次模型调用前被收集。
