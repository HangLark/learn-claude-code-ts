# s14：MCP Tools

## 核心结论

MCP 把外部工具作为运行时发现的数据接入 Agent；Harness 负责命名、组装和授权，server 只负责描述与执行工具。

```text
本轮工具池 = 内置工具 + connect_mcp + 已连接 server 的发现结果
```

## 核心数据

server 暴露的工具定义是外部观察：

```ts
interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}
```

`mcpClients: Map<string, MCPClient>` 是已连接 server 的状态。每次模型调用前，Harness 从它派生一个只服务于当前 cycle 的工具池：

```ts
type McpPolicy = 'allow' | 'confirm';

interface ToolPool {
  definitions: Anthropic.Tool[];
  handlers: ReadonlyMap<string, (input: unknown) => Promise<string>>;
  policies: ReadonlyMap<string, McpPolicy>;
}
```

- `definitions` 交给模型选择工具。
- `handlers` 让宿主把同名调用路由回对应 server。
- `policies` 是宿主拥有的授权配置。

server 的 `annotations` 只是描述性元数据，不能产生授权；未知 MCP 工具也不会因为声明为只读而自动放行。

## 数据流

```text
模型调用 connect_mcp(server)
  → Harness 建立连接并执行 tools/list
  → 保存 MCPClient
  → 当前调用返回发现摘要
  → 下一轮重新 assembleToolPool()
  → 将 server/tool 规范化为 mcp__server__tool
  → definitions 交给模型，handler 与宿主 policy 同名绑定
  → 模型调用外部工具
  → 宿主授权
  → MCPClient.callTool(originalName, input)
  → tool_result 回到 Agent Loop
```

连接发生在一次工具调用中，因此新发现的工具不会修改正在执行的池；只有下一次模型调用前重新组装时才可见。

## 关键约束

- 外部工具必须带 server 命名空间；规范化后的名称仍需检查长度与碰撞，不能静默覆盖内置或其他 server 的工具。
- 展示给模型的定义和宿主执行的 handler 必须在同一注册关系中派生，避免名称与实现分离。
- 授权只能读取宿主策略；server annotation 不能降低权限，未配置策略默认需要确认。
- 一次模型响应中的所有工具调用使用同一个 `ToolPool` 快照，保证定义、handler 和 policy 一致。
