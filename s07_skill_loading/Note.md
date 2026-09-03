# s07：Skill Loading

## 核心结论

Harness 先把技能目录放入 system prompt，只有模型选择某项技能后，才把该技能全文作为工具结果加入消息历史。

```text
常驻上下文 = name + description
按需上下文 = content
```

## 核心数据

每个技能在启动时被规范化为：

```ts
interface Skill {
  name: string;
  description: string;
  content: string;
}
```

- `name` 是模型选择技能和注册表查询使用的关联键。
- `description` 是常驻 system prompt 的派生摘要。
- `content` 是调用 `load_skill` 后才进入 `messages` 的完整外部观察。

`SkillLoader.skills: Map<string, Skill>` 是启动时建立、运行期间只读的注册表。`catalog()` 从注册表派生名称与简介列表；`load(name)` 用名称读取同一条记录的全文。

## 数据流

```text
启动扫描 skills/*/SKILL.md
  → frontmatter + 正文
  → Skill
  → Map<name, Skill>
      ├─ catalog() → system prompt → 每轮模型调用
      └─ load_skill(name) → content → tool_result → messages
```

模型先根据目录判断相关性，再通过既有工具调用协议决定是否承担完整技能内容的上下文成本。

## 关键约束

- 目录和全文必须由同一份 `Skill` 注册表派生，不能分别维护。
- 注册表在 Agent Loop 开始前完成扫描；运行中的技能集合保持稳定。
- `load_skill` 只接受技能名称并查询 Map，不能把模型输入直接解释为文件路径。
- 未调用的技能全文不得进入 system prompt 或消息历史。
- 加载结果沿用普通 `tool_result`，不会改变 Agent Loop 的继续与停止条件。
