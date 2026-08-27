# s07: Skill Loading — 用到时再加载

> system prompt 放目录，完整知识按需进入上下文。

s07 启动时扫描 `skills/*/SKILL.md`，从 YAML frontmatter 读取技能名称和简介，只把这份精简目录放入 system prompt。模型确认某个技能适用后，再调用 `load_skill(name)` 获取完整文件。

| 内容            | 进入模型的位置 | 时机       |
| --------------- | -------------- | ---------- |
| 名称与简介      | system prompt  | 启动时     |
| 完整 `SKILL.md` | `tool_result`  | 模型调用时 |

`load_skill` 只查询启动时建立的注册表，技能名不会被当成文件路径。仓库中的 `skills/code-review/SKILL.md` 是一个最小示例。

## 运行

在仓库根目录准备 `.env` 后执行：

```sh
pnpm s07
```

先询问有哪些技能，再要求模型加载 `code-review`；观察全文只在工具调用后进入消息历史。按 `Ctrl+C` 退出。

s08 会进一步处理长期运行后已经进入历史的旧工具结果。
