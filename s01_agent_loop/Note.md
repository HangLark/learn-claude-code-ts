# s01：Agent Loop

## 核心状态

Agent Loop 的核心可变状态是 `messages: Anthropic.MessageParam[]`。SDK 中单条消息的结构是：

```ts
interface MessageParam {
  content: string | Array<ContentBlockParam>;
  role: 'user' | 'assistant' | 'system';
}
```

`systemPrompt` 和 `tools` 是每轮都会传给模型的静态输入，不进入本章的 `messages`。

## 关键数据

模型用 `Anthropic.ToolUseBlock` 发出动作请求：

```ts
interface ToolUseBlock {
  id: string;
  caller: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
  input: unknown;
  name: string;
  type: 'tool_use';
  toolset_name?: string | null;
}
```

Harness 执行工具后，用 `Anthropic.ToolResultBlockParam` 回填环境观察：

```ts
interface ToolResultBlockParam {
  tool_use_id: string;
  type: 'tool_result';
  cache_control?: CacheControlEphemeral | null;
  content?:
    | string
    | Array<
        | TextBlockParam
        | ImageBlockParam
        | SearchResultBlockParam
        | DocumentBlockParam
        | ToolReferenceBlockParam
        | BrowserStateBlockParam
      >;
  is_error?: boolean;
  toolset_name?: string | null;
}
```

s01 用 `name` 选择工具，用 `input` 传入参数，用 `content` 承载执行结果；`ToolUseBlock.id` 与 `ToolResultBlockParam.tool_use_id` 一一对应，把结果关联回原调用。

## 数据流

```text
用户输入
  → 追加 user message
  → 模型读取 messages、systemPrompt 和 tools
  → 追加模型返回的 assistant message
  → 筛选 tool_use
      ├─ 没有：返回最终 content，结束本轮
      └─ 有：执行全部工具
             → 组成 tool_result[]
             → 追加为一条 user message
             → 再次调用模型
```

`messages` 因此不断积累“请求、动作、观察”，模型根据最新状态决定下一步。

## 不变量

- 模型响应必须先作为 `assistant` 消息进入历史。
- 同一轮的全部工具结果组成一批，再作为 `user` 消息回填。
- 模型只能观察已经回填到 `messages` 的工具结果。
- 模型不再返回 `tool_use` 时，本轮 Agent Loop 结束。
