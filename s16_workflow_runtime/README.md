# s16：Workflow Runtime

s16 在 s15 的统一工具池中只新增一个 `Workflow` 工具。模型选择已注册的 workflow 和参数，可信 TypeScript 脚本负责固定编排：

```text
Workflow(name, args, resume_from_run_id)
  → agent / parallel / pipeline / phase
  → snapshot + append-only journal
  → result + task lifecycle
```

## 核心实现

- `agent()` 可要求 JSON Schema 输出；校验失败只重试一次。
- `parallel()` 是并发屏障；`pipeline()` 让每个输入独立经过 audit → verify 两个阶段。
- 单次运行最多并发 8 个 agent，并共享调用次数与 token 预算。
- journal key 只由 label、prompt 和 schema 的稳定哈希决定，不依赖并发完成顺序。
- resume 会先校验 run ID、workflow、原始参数和 journal，再复用已完成的 agent 结果。
- 快照、输出和 journal 位于本章 `.runtime/`；排他 lock 文件阻止同一 run 在多个进程中同时执行。
- s16 通过 `registerIntegratedTool()` 扩展 s15，主 Agent 循环保持不变。

为保持 YAGNI，示例 pipeline 只实现本章实际使用的两个阶段；崩溃遗留的 lock 文件交由宿主或用户处理。

## 运行

```sh
pnpm s16          # s15 宿主 + Workflow，使用真实 API
pnpm s16 demo     # Mock runner，不调用 API
pnpm s16 resume   # 续跑上一次 demo
```
