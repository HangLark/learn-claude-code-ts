# s05：TodoWrite

## 核心结论

TodoWrite 把模型的计划变成 Harness 持有的显式状态；连续若干工具轮次未更新计划时，Harness 再从这个状态派生提醒。

```text
计划状态 = todo_write 的最近一次成功输入
```

## 核心数据

计划由内存中的 `TodoItem[]` 表示：

```ts
type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface TodoItem {
  content: string;
  status: TodoStatus;
}
```

`TodoManager.items` 是会话内持续维护的状态。每次成功的 `todo_write` 都整体替换它，而不是对旧列表执行隐式增量修改。

工具结果增加了成功语义：

```ts
interface ToolOutcome {
  content: string;
  succeeded: boolean;
}
```

只有成功更新 todo 才能把 `roundsSinceTodo` 清零；被权限阻止、输入无效或未知工具都不能伪装成计划已更新。

提醒和工具结果一起放入 user message。本章第一次直接构造 `Anthropic.TextBlockParam`，SDK 的准确结构是：

```ts
interface TextBlockParam {
  text: string;
  type: 'text';
  cache_control?: CacheControlEphemeral | null;
  citations?: Array<TextCitationParam> | null;
}
```

本章只使用 `type` 和 `text`，让提醒与既有 `tool_result` 同处一批消息内容中。

## 数据流

```text
模型调用 todo_write(todos)
  → 校验并规范化 TodoItem[]
  → 成功：替换 TodoManager.items，usedTodo = true
  → 渲染当前计划
  → 作为 tool_result 回填

本轮全部工具结束
  → usedTodo ? roundsSinceTodo = 0 : roundsSinceTodo += 1
  → 累计到 3
      → 追加 TextBlockParam reminder
      → roundsSinceTodo = 0
```

`TodoItem[]` 是状态，三轮阈值是配置，`todo_write` 是更新事件，完成数和提醒条件都是从状态派生的数据。

## 关键约束

- todo 更新采用整表替换，模型提交的数据就是新的完整计划。
- 同一列表最多一个 `in_progress`，避免同时表达多个当前焦点。
- 只有合法且成功的 `todo_write` 才算一次更新。
- reminder 必须在本轮全部工具处理完成后加入同一条 user message，不能拆散已有工具结果批次。
- TodoWrite 只改变计划的可见状态，不替模型执行或调度任务。
