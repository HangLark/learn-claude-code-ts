# s15：Integrated Harness

## 核心结论

Integrated Harness 不再增加一项独立能力，而是把用户输入、异步事件、动态能力和工具反馈收束到同一个串行 Agent cycle。

```text
统一闭环 = 多入口事件 → 单写者历史 → 实时组装 → 模型 → 统一反馈 → 下一 cycle
```

## 核心数据

s05 的 `ToolOutcome` 在集成层成为全部工具的统一边界：`content` 总会变成对应调用的 `tool_result`，`succeeded` 供 Todo 提醒等派生逻辑读取。本章只新增 `effect?: 'compact'` 控制字段；它不伪装成模型可见文本，而是要求 Harness 在完整工具批次结束后改变上下文状态。

跨回合只需额外保存当前用户目标：

```ts
interface SessionState {
  activeUserRequest: string;
}
```

用户提交会更新它；cron、后台完成和团队邮箱触发的内部回合只能引用它，不能取代它。

每个 cycle 还会派生两组快照：当前 system prompt（时间、记忆、Skill 与连接状态）和当前工具池（内置工具、扩展工具与已发现 MCP 工具）。API 重试、模型切换、输出额度升级和继续次数则是一次 Lead turn 内的恢复状态。

## 数据流

```text
用户输入 ───────────────┐
到期 cron ──────────────┤
后台完成通知 ───────────┼─→ leadTurns 串行入口
团队邮箱事件 ───────────┘
  → 写入或附加到 messages
  → 上下文预算与压缩
  → 组装实时 system prompt 与 ToolPool
  → 调用模型
      ├─ 无工具：Stop Hook → 提取 Memory → 结束本轮
      └─ 有工具：Hook → 权限 → handler
          → 全批 ToolOutcome + 新完成通知 + Todo 提醒
          → 一个 user message
          → 下一 cycle
```

cron 消费后先保持为未确认状态，模型调用成功才 acknowledge；模型调用失败则恢复。后台任务和队友在各自运行时产生事件，只由统一入口把事件写入 Lead 历史。

## 关键约束

- 所有会修改 Lead `messages` 的入口必须经过同一个串行队列；事件可以并发产生，Agent cycle 不能并发执行。
- 每次模型调用前才组装 system prompt 和工具池；一次响应的全部工具调用必须使用同一份池与授权策略。
- 一批工具必须全部执行并形成对应结果后，才能追加反馈或执行显式压缩，保持 `tool_use` 与 `tool_result` 配对。
- 内部唤醒没有正在等待的用户，必须关闭交互授权；需要确认的操作返回拒绝结果。
- API 恢复只能改变当前 turn 的调用策略，不能丢失事件、重复确认 cron，或改写 `activeUserRequest`。

## 闭环变化

s15 将此前分散的重新进入条件统一为 runtime wake：用户可以开始回合，cron、后台完成或团队事件也可以在 Lead 空闲时开始回合；无论入口来自哪里，最终都复用同一条串行循环和同一份会话历史。
