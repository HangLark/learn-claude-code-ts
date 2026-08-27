# s10: Task System — 持久化任务图

> Todo 是当前会话的执行清单；Task System 是可恢复、可协调的工作状态。

s10 把每个任务保存为 `.tasks/task_xxxxxxxx.json`。任务具有独立 ID、状态、负责人和 `blockedBy` 依赖列表，因此 Harness 能判断工作是否可以开始，而不只是知道它尚未完成。

任务图分两步建立：先用 `create_task` 创建全部节点并取得运行时 ID，再用 `update_task` 添加依赖边。更新会拒绝不存在的依赖、自依赖和环。

生命周期只有两个动作：

```text
pending --claim_task--> in_progress --complete_task--> completed
```

`claim_task` 只允许认领所有前置任务均已完成的节点，并写入 owner；`complete_task` 会报告刚被解锁的下游任务。文件留在 `.tasks/`，所以下次启动仍能继续。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s10
```

让模型创建“schema → API → tests”三个任务，再逐个认领和完成；观察 `.tasks/` 中的 JSON 记录及下游解锁提示。按 `Ctrl+C` 退出。

s11 会让耗时命令在后台运行，使 Agent Loop 不必等待工具同步结束。
