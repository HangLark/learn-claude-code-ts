# s16：Workflow Runtime

## 核心结论

Workflow 让模型只选择已注册的流程和参数，由可信 TypeScript 脚本固定编排；稳定 journal key 使同一次运行可以从未完成处重放。

```text
可恢复编排 = 固定 Workflow 脚本 + 可验证 agent 输出 + 稳定调用 journal
```

## 核心数据

注册表把模型可选择的元数据与宿主执行的可信脚本绑定：

```ts
interface WorkflowMeta {
  name: string;
  description: string;
  phases?: readonly string[];
}

type WorkflowScript<Result = unknown> = (
  context: ExecutionState,
  args: Record<string, unknown>,
) => Promise<Result>;

interface WorkflowRegistration {
  meta: WorkflowMeta;
  run: WorkflowScript;
}
```

一次运行的持久状态分为三部分：

- snapshot 保存 `runId`、`workflowName`、原始 `args` 和任务状态。
- append-only journal 保存已完成的 `{ key, value }` agent 调用。
- output 保存整个 Workflow 的最终结果。

journal key 是以下内容的稳定哈希：

```text
key = hash('agent' + label + prompt + stableJson(schema))
```

它描述一次逻辑调用，而不是调用开始或完成的次序；并发调度因此不会改变恢复身份。phase、progress 和 usage 是运行期间产生的观察数据，预算、agent 上限与 semaphore 是整次运行共享的控制状态。

## 数据流

```text
模型调用 Workflow(name, args, resume_from_run_id?)
  → 从注册表取得 meta + script
  → 新运行：保留 runId，创建 snapshot 与 journal
    恢复：校验 runId、workflowName、原始 args，载入 journal
  → 对 runId 加排他锁
  → 执行可信 script
      → phase / parallel / pipeline 决定固定拓扑
      → agent(prompt, schema, label)
          → 计算稳定 key
          ├─ journal 命中：重新校验后复用 value
          └─ 未命中：受并发与预算限制地调用 runner
              → 校验输出 → 追加 journal → 返回 value
  → 写入 output 与最终 snapshot
  → 作为 Workflow 的 tool_result 回到 s15 闭环
```

恢复并不从某一行继续执行脚本，而是用相同参数从入口重放；已经写入 journal 的逻辑调用变成缓存命中，只有缺失的调用再次执行。

## 关键约束

- 模型只能选择注册表中的 Workflow，不能动态生成或修改编排脚本。
- 恢复时 Workflow 名称和参数必须与原运行一致，否则稳定 key 之外的控制流已经不可比较。
- 带 schema 的输出只有通过校验后才能写入 journal；缓存值在复用前也必须按同一 schema 再次校验。
- `parallel` 和 `pipeline` 必须等待本批所有分支落定，使失败前已成功的分支完成 journal 写入，恢复时可直接复用。
- 嵌套 Workflow 必须共享 journal、预算、调用上限与 semaphore，不能借子流程绕过整次运行的限制。
- 同一 `runId` 同时只能有一个执行者，避免两个恢复进程并发追加同一 journal。
