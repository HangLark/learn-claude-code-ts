# s02: Tool Use — 扩展工具，不改循环

> 加一个工具，只加一个注册项。

s02 在 s01 的 agent loop 之外增加 `read_file`、`write_file`、`edit_file` 和 `glob`。每个注册项把 JSON Schema、TypeScript 输入类型和 handler 放在一起，再生成统一的工具列表与 dispatch map。

```text
tool_use -> dispatch map -> handler -> tool_result -> agent loop
```

循环仍然只负责调用模型、执行工具和回填结果；它不需要知道每个工具如何工作。文件工具通过 `safePath` 限制在当前工作目录内，这也是 harness 首个明确的操作边界。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s02
```

可尝试让模型读取文件、创建文件、精确替换文本或查找一组文件。按 `Ctrl+C` 退出。

> [!WARNING]
> Bash 尚未进入权限治理，仍会直接执行模型生成的命令；s03 才会在工具执行前加入权限判断。
