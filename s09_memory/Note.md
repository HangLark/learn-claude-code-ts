# s09：Memory

## 核心结论

Memory 不是压缩后的完整历史，而是从会话中筛选、持久化，并在后续请求中按相关性召回的长期知识。

```text
跨会话上下文 = 相关的持久记忆，而不是旧 transcript
```

## 核心数据

磁盘中的有效记录表示为：

```ts
type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

interface MemoryRecord {
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}
```

`filename` 是记录正文和索引之间的关联键；`name`、`description` 和 `type` 组成可供选择的目录，`body` 只在记录被召回后进入模型上下文。

从当前对话提取出的未决数据使用 `MemoryCandidate`：

```ts
type MemoryScope = 'persistent' | 'current_task';

interface MemoryCandidate {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  scope?: MemoryScope;
}
```

`scope` 是写入前的关键判定数据：只有 `persistent` 候选可以成为 `MemoryRecord`。整理已有记录时不再需要 scope，因为输入已经通过持久性筛选。

`.memory/*.md` 是跨会话状态，`MEMORY.md` 是由所有记录重新生成的派生索引，不是另一份独立事实来源。

## 数据流

```text
新一轮开始
  → 最近 user 消息 + MemoryRecord 目录
  → 相关性选择，失败时退回关键词匹配
  → 最多 5 个 filename
  → 加载对应正文，总量最多 20,000 字符
  → 目录 + 相关正文进入本轮 system prompt

本轮准备结束
  → 最近对话
  → 模型提出 MemoryCandidate[]
  → 字段、scope、临时语义和重复性筛选
  → persistent 候选写入独立 Markdown
  → 重建 MEMORY.md
  → 记录达到阈值时合并、纠正或删除旧记录
```

召回结果是供当前 Agent 使用的背景观察；提取候选只是建议，Harness 的确定性筛选才决定是否改变持久状态。

## 关键约束

- 索引必须由实际记录重建，不能与正文分别维护。
- 召回先选目录项再加载正文，未选中的记忆正文不得进入上下文。
- 记忆被标记为背景数据；与当前用户请求冲突时，当前请求优先。
- `current_task`、含临时语义或与现有记录重复的候选不得写盘。
- 提取发生在模型完成当前回答之后，不能把尚未完成的过程状态当作长期知识。
- consolidation 必须先验证整个新集合；替换失败时恢复旧记录和索引，避免留下半套记忆状态。
