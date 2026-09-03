# s10：Task System

## 核心结论

Harness 把工作保存为带依赖边和所有权的持久任务图，再从图状态判断任务是否可认领以及完成后解锁了什么。

```text
可认领 = pending && 所有 blockedBy 已 completed
```

## 核心数据

每个任务文件保存一条 `Task`：

```ts
type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
}
```

- `id` 是文件、工具输入和依赖边共同使用的关联键。
- `status` 与 `owner` 共同表示执行生命周期。
- `blockedBy` 保存当前节点指向前置节点的有向边。

`.tasks/task_<id>.json` 是跨进程重启保留的状态；`incompleteDependencies`、ready task 和完成后新增的 unblocked task 都是从任务图实时派生的数据。

## 数据流

```text
create_task(subject)
  → 生成运行时 id
  → 写入 pending、owner=null、blockedBy=[] 的节点

update_task(task_id, dependency_ids)
  → 读取完整任务图
  → 验证节点、边和无环性
  → 把依赖边写入目标节点

claim_task(task_id, owner)
  → 读取 blockedBy 对应状态
  → 全部 completed
  → status=in_progress，写入 owner

complete_task(task_id, owner)
  → 校验当前所有者
  → status=completed
  → 比较更新前后的 ready task
  → 返回刚解锁的下游任务
```

模型通过任务工具产生图和状态转换，Harness 根据磁盘中的完整图决定转换是否合法。

## 关键约束

- 必须先创建全部节点并取得真实 ID，再用这些 ID 添加依赖边。
- 依赖只能在任务仍为 `pending` 且无人认领时增加。
- 依赖目标必须存在，且不得形成自依赖或环。
- 任务只能沿 `pending → in_progress → completed` 前进。
- `claim_task` 必须在所有前置任务完成后同时写入状态和 owner。
- 只有记录中的 owner 可以完成 `in_progress` 任务。
- “已解锁”是一次完成前后图状态的差集，不是额外保存的任务字段。
