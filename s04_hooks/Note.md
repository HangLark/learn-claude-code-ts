# s04：Hooks

## 核心结论

Harness 把扩展行为注册到 Agent cycle 的命名节点，核心循环只负责触发节点并解释 hook 的返回值。

```text
扩展行为 = HookEvent + 与事件匹配的 callback
```

## 核心数据

`HookArguments` 是事件名与参数元组的唯一映射：

```ts
interface HookArguments {
  UserPromptSubmit: [query: string];
  PreToolUse: [toolCall: Anthropic.ToolUseBlock, readline: ReadlineInterface];
  PostToolUse: [toolCall: Anthropic.ToolUseBlock, output: string];
  Stop: [messages: Anthropic.MessageParam[]];
}
```

其中的 SDK 类型已在前面章节展开；本章新增的是不同生命周期节点对同一批数据的不同观察时机。

事件名、回调和注册表都从这份映射派生：

```ts
type HookEvent = keyof HookArguments;

type Hook<Event extends HookEvent> = (
  ...args: HookArguments[Event]
) => string | undefined | Promise<string | undefined>;

type HookRegistry = { [Event in HookEvent]: Hook<Event>[] };
```

`hooks` 是 Harness 持有的配置：键决定触发位置，数组顺序决定同一位置上回调的执行顺序。hook 返回 `undefined` 表示不干预，返回字符串则成为控制信号。

## 数据流

```text
registerHook(event, callback)
  → callback 进入 hooks[event]

Agent cycle 到达 event
  → triggerHooks(event, ...对应参数)
  → 按注册顺序调用 callbacks
  → 第一个非 undefined 字符串
      ├─ PreToolUse：代替 handler 输出，作为 tool_result 回填
      └─ Stop：作为新的 user message，重新进入 Agent Loop
```

s03 的权限判定没有消失，而是成为 `PreToolUse` 上的一个 callback；日志等行为可以挂在同一节点，不再进入工具分发代码。

## 关键约束

- `HookEvent`、回调参数和注册表槽位必须保持类型关联。
- 同一事件的 hook 按注册顺序执行；第一个控制字符串会终止该事件余下回调。
- `PreToolUse` 必须在 handler 之前触发，`PostToolUse` 只观察真正执行后的输出。
- hook 的控制字符串沿用既有消息协议，不建立第二套反馈通道。

## 闭环变化

s01–s03 在模型不再返回 `tool_use` 时直接停止。s04 先触发 `Stop`：只有所有 Stop hook 都返回 `undefined` 才真正结束；任一 hook 返回字符串，就把它加入 `messages` 并继续原来的循环。
