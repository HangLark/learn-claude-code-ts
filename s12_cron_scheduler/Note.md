# s12：Cron Scheduler

## 核心结论

Cron Scheduler 把“何时向 Agent 交付哪个 prompt”保存成状态；任务到期后先标记待交付并入队，只有模型成功接收后才确认。

```text
交付语义 = 持久化 pendingDelivery → 入队 → 模型接收 → acknowledge
```

## 核心数据

每个调度任务表示为：

```ts
interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  pendingDelivery: boolean;
  lastFired: string | null;
}
```

- `cron` 和 `prompt` 是调度规则与待交付事件内容。
- `recurring` 决定成功交付后保留还是删除任务。
- `durable` 决定任务是否进入 `.scheduled_tasks.json`。
- `pendingDelivery` 表示已到期但尚未被模型确认接收。
- `lastFired` 是分钟标记，防止同一任务在同一分钟重复触发。

`jobs` 是当前任务状态，`queue` 是等待 Agent 消费的事件队列；持久文件只保存 `durable` 任务。解析后的 cron 字段和“此刻是否匹配”是从配置与当前时间派生的数据。

## 数据流

```text
schedule_cron
  → 创建 CronJob(pendingDelivery=false)
  → durable 时原子保存

poll(current local minute)
  → cron 匹配 && 非 pending && 本分钟未触发
  → pendingDelivery=true，lastFired=minute
  → durable 时先保存
  → 加入 queue

Agent 空闲
  → consume() 取走 queue
  → 每个 prompt 变成 [Scheduled] user message
  → 调用模型
      ├─ 调用失败：删除临时消息，restore 回 queue
      └─ 调用成功：acknowledge
          ├─ recurring：pendingDelivery=false
          └─ one-shot：删除任务
```

`pendingDelivery` 同时连接磁盘状态和内存队列，使进程重启后仍能恢复尚未确认的交付。

## 关键约束

- durable job 必须先保存 `pendingDelivery=true`，之后才能进入队列。
- 只有模型调用成功返回，才表示 scheduled prompt 已被接收并可以 acknowledge。
- 消费队列不等于确认；调用失败的任务必须恢复，形成至少一次而非至多一次交付。
- 周期任务确认后清除 pending，一次性任务确认后删除。
- poll、schedule、cancel、consume、acknowledge 和 restore 必须串行修改同一任务状态。
- 定时回合与用户回合共用一个 Agent 锁，不能并发写同一份 `messages`。
- 定时回合没有正在等待的用户，因此需要交互审批的工具必须拒绝执行。

## 闭环变化

s11 的后台完成事件只能等待下一次用户输入。s12 的队列处理器会在 Agent 空闲且存在到期任务时主动开始一轮 Agent Loop，因此“定时 prompt 到期”成为用户输入之外的新入口；这一入口仍与用户回合串行共享同一份历史。
