# 第八阶段：对话式定时任务工具

> 状态：已实现（2026-08-19）。

## 1. 目标

让普通单轮 CLI 和常驻 REPL 中的 Agent 能通过四个专用工具管理本地定时任务：

- `schedule_add`：创建一次性或固定间隔任务；
- `schedule_list`：列出任务、下次运行和最近状态；
- `schedule_remove`：删除指定任务；
- `schedule_run`：立即执行已保存任务。

用户无需记忆 CLI 语法，可以直接说“每 24 小时检查测试”。若一次性时间缺少日期或时区，Agent 必须先向用户确认，不能自行猜测。首版固定间隔从创建时刻开始，不声称支持 cron 式墙上时钟规则。

## 2. 工具契约

`schedule_add` 接受 `id`、`task`、可选 `session_id`，并且必须且只能提供：

- `at`：含 `Z` 或明确偏移的 ISO 8601 时间；或
- `every`：`10s`、`15m`、`2h`、`1d` 等固定间隔。

四个工具复用 `ScheduleStore`、时间解析器和 `TaskScheduler`，不另建持久化格式。返回值保持结构化，不暴露 `.andi-agent` 内部路径。

## 3. 执行与安全

- 只有用户明确要求安排、查看、删除或立即运行任务时才调用相应工具；
- 创建和删除直接写入受保护的任务注册表；
- `schedule_run` 通过注入的 scheduled runner 执行，并传递当前 `AbortSignal`；
- scheduled runner 不注册这四个工具，防止任务递归创建或运行其他任务；
- 被立即启动的任务仍采用非交互审批：安全验证命令可运行，安装依赖及 Git 写操作会拒绝；
- 工具错误通过现有 ToolRegistry 返回模型，取消则继续向上传播。

## 4. 集成位置

新增 `src/tools/scheduler.ts`，导出 `createSchedulerTools(store, options)`。普通 CLI/REPL 的工具注册表加入四个工具；`createScheduledAgentRunner` 保持现有 coding tools 集合，不加入调度工具。

系统提示增加时间确认和显式用户意图规则。`src/index.ts` 导出工具工厂与配置类型。

## 5. 测试与验收

- 工具定义和 JSON schema 包含四个稳定名称；
- add 支持 at/every，并拒绝两者同时提供、无时区时间和非法 ID；
- list 返回结构化任务摘要；
- remove 正确报告删除结果和不存在任务；
- run 调用注入 runner，持久化 completed/failed/cancelled 状态并返回 output/run ID；
- AbortSignal 可取消立即运行；
- Agent 工具注册表包含四个工具，而 scheduled runner 不递归包含它们；
- `bun test`、`bun run typecheck` 和 CLI help 全部通过。

## 6. 实现结果

- 四个工具已接入普通单轮 CLI 与常驻 REPL；
- `schedule_run` 复用 TaskScheduler，并返回 output、run ID 和持久化状态；
- scheduled runner 明确不注册调度工具，避免递归；
- 系统提示加入显式用户意图和一次性时间确认规则；
- 完整自动化测试通过（67 tests）。
