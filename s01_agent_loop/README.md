# s01: Agent Loop — 一个循环就够了

> One loop & Bash is all you need.

s01 只引入一件事：当模型返回 `tool_use` 时，执行工具并把 `tool_result` 追加回消息历史；当模型不再调用工具时，循环结束。

```text
User -> messages[] -> LLM -> tool_use?
                           | yes: execute -> append result -> loop
                           | no:  return final text
```

模型负责判断下一步，harness 只负责提供 Bash、执行命令和回传观察结果。后续章节会增加工具、权限和上下文机制，但这个循环不会改变。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s01
```

输入 `q`、`exit` 或空行退出。

> [!WARNING]
> 这一章没有权限治理，会直接执行模型生成的 shell 命令。请在可丢弃的测试目录中运行；权限控制会在后续章节加入。
