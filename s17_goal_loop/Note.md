# s17：Goal Loop

## 核心结论

有活跃 Goal 时，“模型不再调用工具”只表示 worker 想停止；只有独立 evaluator 确认完成，Stop gate 才允许真正返回。

```text
退出条件 = 无 tool_use && 独立 evaluator 允许退出
```

## 核心数据

Goal 是跨多个 Agent turn 保留的会话状态：

```ts
interface GoalState {
  condition: string;
  iterations: number;
  setAt: number;
  tokensAtStart: number;
  lastReason?: string;
}

interface GoalEvaluation {
  ok: boolean;
  reason: string;
  impossible: boolean;
}
```

`condition` 是 evaluator 判断的完成条件；`iterations` 和 `lastReason` 记录判断进度，其余字段只用于报告耗时与 token 消耗。

判断结果先转换为 Stop gate 的有限动作：

```ts
type StopDecision =
  | { action: 'allow' }
  | { action: 'defer' | 'block' | 'error' | 'limit'; reason: string }
  | { action: 'achieved' | 'failed'; reason: string };
```

`active / achieved / failed / inactive` 状态事件是 Goal 生命周期的可持久观察；恢复时以最后一个有效事件决定是否重建活跃条件。连续阻止次数属于一次外部查询的控制状态，不等同于 Goal 的总评估次数。

## 数据流

```text
/goal condition
  → 保存 GoalState，并把 condition 交给 worker
  → worker 正常执行工具循环
  → 某轮无 tool_use
      ├─ 无活跃 Goal：allow
      ├─ 后台仍运行：defer，保留 Goal
      └─ 独立 evaluator(condition, transcript)
          ├─ ok：achieved，清除 active Goal，返回
          ├─ impossible：failed，清除 active Goal，返回
          ├─ 判断失败或达到阻止上限：保留 Goal，返回控制权
          └─ 尚未完成：block
              → 将缺失证据作为新 user message
              → worker 继续同一个 loop
```

evaluator 只接收完成条件和近期对话证据，没有工具。它的结论不能直接改变仓库，只能决定退出、继续或把控制权交还用户。

## 关键约束

- Goal 判断只能发生在 worker 原本准备返回的边界；只要仍有工具调用，就必须先执行并记录对应结果。
- evaluator 必须与 worker 分离、禁用工具，并把 Goal 与 transcript 当作数据，避免任务内容反过来操纵判断器。
- 完成只能依据对话中已经出现的证据；没有工具结果时，worker 的完成声明不等于外部事实。
- evaluator 错误、后台未结束、全局 turn 上限或连续阻止上限都不能伪造成功；这些情况保留活跃 Goal 并返回用户。
- `block` 必须把 evaluator 的理由写回同一份 `messages`，否则 worker 不知道还缺少什么证据。

## 闭环变化

s16 之前，模型停止调用工具即可结束当前 Agent Loop。s17 在这个唯一出口增加 Goal gate：未完成的判断会生成新的用户消息并重新进入 worker，直到目标完成、不可能完成，或安全限制把控制权交还用户。
