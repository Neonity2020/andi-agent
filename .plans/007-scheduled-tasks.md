# 第七阶段：本地定时任务

> 状态：已实现（2026-08-19）。

## 1. 阶段目标

为 andi-agent 增加可持久化的本地定时任务，使 coding task 能在指定时间或固定间隔自动执行，并复用现有 Agent、session、检查点、取消与运行日志能力。

首版提供：

- 一次性任务：在带时区的 ISO 8601 时间执行；
- 周期任务：按秒、分、时、天的固定间隔执行；
- 创建、列表、删除、手动触发和常驻 scheduler 命令；
- 单进程内同一任务不重叠；
- Ctrl-C 停止 scheduler，并取消当前 Agent 运行；
- 记录最近运行状态、时间、run ID 和截断错误。

## 2. CLI 设计

```bash
bun run start -- schedule add nightly --every 24h --session nightly -- "运行测试并修复失败"
bun run start -- schedule add release-check --at 2026-08-20T09:00:00+08:00 -- "检查发布状态"
bun run start -- schedule list
bun run start -- schedule run nightly
bun run start -- schedule remove nightly
bun run start -- scheduler
```

- `schedule add` 必须且只能提供 `--at` 或 `--every`；
- `--at` 必须包含 `Z` 或显式时区偏移，避免机器时区变化产生歧义；
- `--every` 接受 `30s`、`15m`、`2h`、`1d`，最短 10 秒；
- `--session` 可选；未提供时使用独立的 `schedule-<id>` session；
- 后台运行固定采用 `approval: never`，不能等待终端审批；
- `schedule list` 不要求 API Key，只有实际执行任务时才加载模型配置。

## 3. 数据模型与持久化

任务注册表保存于 `.andi-agent/schedules.json`：

```ts
interface ScheduledTask {
  id: string;
  task: string;
  schedule: { kind: "once"; at: string } | { kind: "interval"; everyMs: number };
  sessionId: string;
  enabled: boolean;
  createdAt: string;
  nextRunAt?: string;
  lastRun?: {
    startedAt: string;
    finishedAt?: string;
    status: "running" | "completed" | "failed" | "cancelled";
    runId?: string;
    error?: string;
  };
}
```

- 使用临时文件加 rename 原子保存，并串行化进程内写入；
- 严格校验版本、任务 ID、时间和状态；
- 文件位于受保护的 `.andi-agent/`，模型工具无法读取或修改；
- 一次性任务启动前即禁用；周期任务启动前先推进 `nextRunAt`，采用 at-most-once 调度，避免崩溃恢复后重复执行有副作用的 coding task；
- 若 scheduler 离线错过多个周期，恢复时只执行一次，然后将下一次时间推进到未来。

## 4. 调度运行时

新增与模型无关的 `TaskScheduler`：

1. 每个轮询周期读取注册表中的最近到期时间；
2. 到期后先持久化 `running` 状态及新的 `nextRunAt`；
3. 通过注入的 runner 顺序执行任务；
4. 写入 completed/failed/cancelled 状态；
5. 继续等待下一项，单个任务失败不终止 daemon。

Scheduler 启动时将遗留的 `running` 标记为 failed/interrupted，不自动重复执行。首版全局串行执行，避免多个 Agent 同时修改同一工作区。

## 5. Agent 集成

- 每个任务通过自己的 session 加载历史并使用 checkpoint 保存；
- 强制启用结构化 `RunRecorder`，日志写入 `.andi-agent/runs/`；
- runner 保存本轮累计 usage，并把最终 run ID 回写任务状态；
- scheduler 的 AbortSignal 传给 `Agent.runWithHistory`；
- 命令和 Git 写操作因无交互 approver 而拒绝，安全验证命令仍可按现有白名单运行。

## 6. 代码结构

```text
src/scheduler/
├── types.ts       # task、schedule、run 状态
├── parser.ts      # CLI、ISO 时间与 duration 校验
├── store.ts       # 原子注册表持久化
└── scheduler.ts   # due 计算、daemon、取消与状态更新
```

`src/cli.ts` 负责命令路由和 Agent runner 组装，`src/index.ts` 导出可复用的调度 API。

## 7. 测试计划

- duration、带时区 ISO 时间和命令参数校验；
- add/list/remove 的持久化往返与损坏文件拒绝；
- 一次性任务只执行一次；
- 周期任务推进到未来，漏过多个周期时不突发补跑；
- 同一 scheduler 全局串行，不重叠执行；
- 单任务失败不影响后续任务；
- 启动恢复遗留 `running` 状态；
- Ctrl-C/AbortSignal 取消 active runner；
- 实际 runner 复用 session checkpoint、usage 和 JSONL 日志；
- 原有单次 CLI 与 REPL 参数保持兼容。

## 8. 验收标准

- `bun test`、`bun run typecheck`、CLI help 冒烟测试通过；
- 任务增删查无需 API Key；
- scheduler 重启后仍能读取任务和下一运行时间；
- 到期任务执行后状态持久化，失败不会杀死 daemon；
- 无人值守任务不会等待交互审批；
- scheduler 停止后没有遗留 Agent 请求或子进程。

## 9. 非目标

首版不包含 cron 表达式、自然语言时间、macOS launchd/systemd 安装、分布式多实例锁、Web UI、通知渠道和并行任务。后续可在稳定的数据模型上继续扩展。

## 10. 实现结果

- 已实现 `schedule add/list/remove/run` 与常驻 `scheduler`；
- 已实现一次性/固定间隔调度、原子注册表、遗留 running 状态恢复和全局串行执行；
- scheduled runner 已复用 session v2、usage、检查点、AbortSignal 与脱敏 JSONL 日志；
- 管理命令不加载模型配置，后台执行固定使用非交互审批；
- 类型检查、CLI 冒烟及完整自动化测试通过（62 tests）。
