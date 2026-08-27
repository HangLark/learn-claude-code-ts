# learn-claude-code-ts

[`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code) 的 TypeScript 转写，用 TS 逐章学习 coding agent harness 的核心机制。

范围仅包含 `s01_agent_loop` 到 `s17_goal_loop`。每一章保持独立可运行，保留上游的关键理念，不提前引入后续抽象。

## 环境

- Node.js 24+
- pnpm 11+

## 开始

```sh
pnpm install
cp .env.example .env
# 编辑 .env，填写 ANTHROPIC_API_KEY 和 MODEL_ID
pnpm s01
```

运行质量检查：

```sh
pnpm check
```

> [!WARNING]
> s01 会直接执行模型生成的 shell 命令。请在可丢弃的测试目录中体验；权限控制会在后续章节加入。

## 进度

- [x] s01 Agent Loop
- [x] s02 Tool Use
- [x] s03 Permission
- [x] s04 Hooks
- [x] s05 TodoWrite
- [ ] s06-s17

本项目基于上游 MIT 许可进行转写，原作者版权声明保留在 [LICENSE](LICENSE) 中。
