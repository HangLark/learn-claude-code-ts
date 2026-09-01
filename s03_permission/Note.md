# s03：Permission

## 核心结论

Harness 在工具分发前加入权限门，只有通过判定的 `tool_use` 才会交给 handler 执行。

```text
允许执行 = 未命中硬拒绝 &&（未命中权限规则 || 用户明确批准）
```

## 核心数据

权限规则是 Harness 持有的静态配置：

```ts
interface PermissionInput {
  command?: string;
  path?: string;
}

interface PermissionRule {
  tools: readonly string[];
  reason: string;
  matches: (input: PermissionInput) => boolean;
}
```

- `tools` 限定规则适用的工具。
- `matches` 根据本次调用的输入判断是否需要审批。
- `reason` 向用户说明触发审批的原因。

`denyList` 表示不可批准的操作；`permissionRules` 表示需要用户决定的操作。两者共同把 `Anthropic.ToolUseBlock` 派生为“允许”或“拒绝”。

## 数据流

```text
Anthropic.ToolUseBlock
  → 命中 denyList ───────────────────────→ 拒绝
  → 未命中 → 匹配 permissionRules
                ├─ 无匹配 ───────────────→ handler
                └─ 有匹配 → 用户明确批准 ─→ handler
                           └─ 其他输入 ───→ 拒绝

拒绝 → Permission denied. → 沿用已有 tool_result 回填流程
```

## 关键约束

- 硬拒绝优先于规则匹配，命中后不能由用户放行。
- 权限检查必须发生在 handler 之前，模型不能绕过 Harness 的执行边界。
- 审批默认拒绝，只有 `y` 或 `yes` 才允许执行。
- 规则只判断“是否需要审批”，不直接代表拒绝。
