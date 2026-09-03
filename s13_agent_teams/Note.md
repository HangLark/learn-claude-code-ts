# s13：Agent Teams

## 核心结论

Agent Teams 为每个队友保留独立对话与运行循环，并用共享任务所有权和类型化邮箱协议协调它们。

```text
团队协作 = 独立 Agent 状态 + 原子任务认领 + 持久消息协议
```

## 核心数据

s10 的持久任务新增 `worktree: string | null`：任务的 `owner` 决定由谁执行，`worktree` 决定执行时使用哪个工作目录。

队友之间不共享 `messages`，只交换邮箱事件：

```ts
interface MailEnvelope {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

type MailEvent =
  | {
      type:
        'message' | 'plan_request' | 'error' | 'result' | 'idle_notification';
    }
  | { type: 'shutdown_request'; requestId: string }
  | { type: 'shutdown_response'; requestId: string; approve: true }
  | { type: 'plan_approval_request'; requestId: string }
  | { type: 'plan_approval_response'; requestId: string; approve: boolean };

type MailMessage = MailEnvelope & MailEvent;
```

每个队友还持有两组运行时状态：

- `working | waiting_approval | idle | stopping` 表示当前生命周期。
- `not_required | required | pending | approved | rejected` 表示当前工作版本的计划门禁。

邮箱文件是尚未消费的协作事件，任务存储是团队共享事实；“哪些任务可认领”和“队友是否应继续工作”都由这些状态派生。

## 数据流

```text
Lead 创建或分配 Task
  → 原子写入 owner，可选绑定 worktree
  → 启动拥有独立 messages 的 Teammate
  → Teammate 处理邮箱
  → 认领并执行 ready Task
  → 通过邮箱发送 result / error / idle_notification
  → Lead 消费事件并继续协调
```

空闲队友每轮先读取邮箱，再尝试认领一个依赖已满足的任务。邮箱采用追加写入、读取后消费的方式，让发送者和接收者不必共享调用栈或对话历史。

需要计划审批时，队友先发送带 `requestId` 的请求。Lead 的响应只有在请求、当前任务和工作版本仍然一致时，才会改变计划门禁。

## 关键约束

- 任务认领与 `owner → task` 分配必须串行；一个队友同一时刻只能拥有一个未结束任务。
- 队友只有认领任务后才能执行文件或 Shell 工具；`worktree` 只改变工作目录，不提供安全隔离。
- 重新分配工作必须递增工作版本并使旧计划请求失效，避免迟到响应批准新任务。
- 计划未批准时，受门禁保护的工具和任务完成操作都不能执行。
- 关闭队友必须经过带关联 ID 的 request/response 握手，不能把普通消息误当成关闭确认。

## 闭环变化

队友不随一次工具调用结束，而是在 `working → idle → working` 之间持续运行；新任务或邮箱事件可以重新激活它。团队事件也会唤醒 Lead，但所有 Lead 回合仍串行修改同一份历史。
