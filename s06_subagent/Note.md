# s06：Subagent

## 核心结论

`task` 把子任务放进一份全新的消息历史中执行，父 Agent 只接收子循环的最终文本，而不接收它的中间推理轨迹。

```text
父上下文看到的子任务数据 = prompt + final text
```

## 核心数据

本章没有改变 `Anthropic.MessageParam` 的结构，而是同时维护两份生命周期不同的数组：

```ts
parentMessages: Anthropic.MessageParam[]; // 整个用户会话
subagentMessages: Anthropic.MessageParam[]; // 单次 task 调用
```

`subagentMessages` 以 task 的 `prompt` 作为唯一初始 user message，随后只积累子 Agent 自己的 assistant 响应和工具结果。它在 `runSubagent` 返回后结束生命周期。

两套工具池是静态配置：

```text
父工具池 = 基础工具 + task
子工具池 = 基础工具
```

因此消息上下文被隔离，但工作目录、工具 handler、权限与 hooks 仍由同一个 Harness 共享。

## 数据流

```text
父模型产生 task(prompt)
  → 创建 fresh subagentMessages = [user(prompt)]
  → 子模型在 subagentMessages 中循环
      → 工具调用与结果只写入 subagentMessages
      → 无 tool_use 时提取最终文本
  → 最终文本成为父 task 调用的 tool_result
  → 只有这条结果进入 parentMessages
```

父模型从最终 `tool_result` 观察子任务结论；文件修改则通过共享工作目录成为双方都能观察到的外部状态。

## 关键约束

- 每次 `task` 调用必须创建新的 `messages`，不能复用父历史或上一次子任务历史。
- 子工具池不包含 `task`，所以委派深度固定为一层。
- 子循环的中间 assistant 消息和工具结果不能复制到父历史。
- 父循环仍需用原 `tool_use_id` 把子 Agent 的最终文本关联回 `task` 调用。
- 上下文隔离不等于文件系统隔离；父子 Agent 对同一工作目录的修改互相可见。

## 闭环变化

父 Agent 执行 `task` 时同步等待一个内层 Agent Loop。子循环在模型不再调用工具且 Stop hooks 放行时结束；若 30 轮仍未结束，则由 Harness 生成停止文本。无论哪种出口，父循环都只得到一个普通工具结果并沿用原有闭环。
