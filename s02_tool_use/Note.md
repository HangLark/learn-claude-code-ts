# s02：Tool Use

## 核心结论

工具的 `definition` 和 `handler` 在同一个注册项中声明，再从统一注册表派生模型需要的工具定义和 Harness 需要的分发表。

```text
RegisteredTool = definition + handler
```

## 核心数据

`definition` 是 `Anthropic.Tool`。这个 SDK 类型较大，s02 只依赖以下字段：

```ts
type ToolDefinition = Pick<
  Anthropic.Tool,
  'name' | 'description' | 'input_schema'
>;

// ToolDefinition 展开后的结构
interface ToolDefinitionShape {
  name: string;
  description?: string;
  input_schema: InputSchema;
}

interface InputSchema {
  type: 'object';
  properties?: unknown | null;
  required?: string[] | null;
  [key: string]: unknown;
}
```

本地的 `RegisteredTool` 把这份定义和可执行的处理器绑定在一起：

```ts
interface RegisteredTool {
  definition: Anthropic.Tool;
  run: (input: unknown) => Promise<string>;
}
```

统一声明由 `defineTool<Input>()` 完成：

```ts
function defineTool<Input>(
  definition: Anthropic.Tool,
  handler: (input: Input) => Promise<string>,
): RegisteredTool;
```

JSON Schema、TypeScript 输入类型和 handler 因此位于同一个注册点。

## 数据流

```text
registeredTools
  ├─ definition → Anthropic.Tool[] → 发送给模型
  └─ name + run → Map<string, handler> → Harness 分发表

ToolUseBlock.name
  → toolHandlers.get(name)
  → handler(ToolUseBlock.input)
  → string
  → 沿用 s01 的 tool_result 回填流程
```

## 关键约束

- `registeredTools` 是唯一事实来源，工具定义列表和 handler map 都由它生成。
- `Anthropic.Tool.name` 与 `ToolUseBlock.name` 是定义和执行之间的关联键。
- 模型返回的 `input` 在运行时是 `unknown`，到注册点才转换为 handler 的 `Input`。
