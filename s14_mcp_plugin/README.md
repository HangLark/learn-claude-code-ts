# s14: MCP Tools — 动态发现外部工具

> Agent loop 不需要理解每个服务；Harness 负责连接、发现、命名、调度与授权。

s14 从 s04 的基础工具和 Hooks 出发，加入两个进程内模拟 MCP server：`docs` 与 `deploy`。开始时模型只看到 `connect_mcp`；连接后，下一轮动态工具池才会出现 `mcp__docs__search` 一类外部工具。

`MCPClient` 用 `listTools()` 暴露发现结果，用 `callTool()` 提供统一调用入口。Harness 为工具添加 `mcp__{server}__{tool}` 前缀，并检查规范化后的重名与 64 字符限制。工具定义和 handler 在注册点绑定，避免分别维护。

server 提供的 `readOnlyHint` 或 `destructiveHint` 不是授权。是否直接执行由宿主策略决定：docs 查询与部署状态可直接调用，触发部署需要用户确认，未知外部工具默认也要确认。错误会变成 `tool_result`，让模型下一轮自行修正。

本章只模拟 MCP 的 `tools/list` 与 `tools/call` 边界，不实现真实 transport，也不带入 Task、Background、Cron 或 Team。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s14
```

可以让 Agent 连接 docs 并搜索文档，或连接 deploy 查看服务状态。按 `Ctrl+C` 退出。

s15 会把此前各章的能力合并进 Integrated Harness。
