# s17 — Goal Loop

本章把 agent loop 的退出条件从“模型不再调用工具”升级为“独立判断器确认目标已经完成”。

## 核心机制

输入一个可验证的会话级目标：

```text
/goal pnpm check 退出码为 0，并且没有修改测试文件
```

它会立即成为主模型的任务。当主模型停止调用工具时，`GoalController` 才在原本的返回位置调用一个独立、无工具的 evaluator：

```text
worker 不再调用工具
        ↓
evaluator 检查目标和对话证据
        ├─ 完成 / 不可能 / 出错 → 返回用户
        └─ 未完成 → 把缺失证据写回 messages[]，继续同一个 loop
```

因此，主模型负责工作，evaluator 只负责判断；没有活跃 Goal 时，退出行为仍与 s01 相同。

## 为什么只读对话

evaluator 没有工具，只能依据对话中已经出现的命令、退出码和工具结果。它不会把“我觉得已经完成”当作外部事实，也不会自行修改环境。最近的完整消息会被保留；只有最新消息本身过大时才截取头尾。

一个好的 Goal 应写清：

- 最终状态；
- 用什么结果证明；
- 不能破坏的约束。

Goal Loop 不是测试框架，验证仍由主模型通过工具执行。

## 保持可控

- `MAX_TURNS` 限制单次自动执行的总轮数；
- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 限制 Stop gate 连续要求继续的次数；
- evaluator 失败或达到限制时保留 Goal，把控制权交还用户；
- 后台工作仍在运行时返回 `defer`，结果通过 `submitBackgroundResult()` 回到同一份对话后再判断。

使用 `/goal` 查看状态，`/goal clear` 清除；设置新 Goal 会替换旧 Goal。`GoalController.restore()` 可从宿主保存的状态事件恢复活跃条件，但本章 CLI 不负责会话持久化。

## 运行

```sh
# .env
ANTHROPIC_API_KEY=...
MODEL_ID=...

# 可选：用更小的模型作判断器
GOAL_EVALUATOR_MODEL_ID=...

pnpm s17
pnpm s17 -- "/goal pnpm check 退出码为 0"
```

代码保留五个基础工具与四类 hook 作为承载层；本章只新增 Goal 所需的状态、判断器和 Stop gate，不引入 s15/s16 的集成设施。
