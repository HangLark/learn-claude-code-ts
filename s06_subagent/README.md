# s06: Subagent — 给子任务独立上下文

> 子任务使用全新的 `messages[]`，父对话只接收最终文本。

s06 新增 `task` 工具。它同步启动第二个 agent loop，把 task prompt 作为唯一的初始用户消息；子 Agent 完成后，最终文本成为父 Agent 的一条 `tool_result`。

```text
parent messages -> task(prompt) -> fresh subagent messages
                <- final text  <- tools and intermediate results
```

隔离的是上下文，不是进程和文件系统。父子 Agent 使用同一个工作目录，也共享权限与生命周期 hooks，因此子 Agent 的文件修改立即可见。

子工具池只包含五个基础工具，没有 `task`，本章只允许一层委派。30 轮仍未给出最终文本时，harness 会停止子循环并把停止原因返回父 Agent。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s06
```

让父 Agent 委派一次代码检索或独立文件修改，观察 `[sub]` 工具轨迹不会进入父消息历史。按 `Ctrl+C` 退出。

s07 会用同样的按需思想，只在需要时把技能知识加载进上下文。
