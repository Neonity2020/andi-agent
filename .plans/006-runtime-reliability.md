# 第六阶段：运行可靠性、检查点与可观测性

> 状态：已实现（2026-08-18）。自动化类型检查与测试已通过；真实 Agnes 的网络取消可按第 9 节手动复验。

## 1. 阶段目标

让常驻 REPL 能安全处理中断、网络失败和进程崩溃，并让用户清楚看到每轮模型与工具消耗。本阶段优先解决运行时可靠性；自动上下文摘要、AST/LSP 和 MCP 延后到后续阶段。

完成后应具备：

- Ctrl-C 取消正在运行的一轮，而不是直接关闭整个 REPL；
- 取消信号贯穿 Agnes 请求、SSE reader、工具和子进程；
- 每次消息变化后保存检查点，崩溃后可恢复；
- 检测并修复不完整的 tool-call/tool-result 对；
- 统计请求耗时、输入/输出 token 和工具耗时；
- `/status`、`/usage` 能展示当前 session 的运行状态与累计用量。

## 2. 统一取消链路

### 2.1 API 设计

新增 `AgentRunOptions`：

```ts
interface AgentRunOptions {
  signal?: AbortSignal;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => Promise<void>;
}
```

`CompletionOptions` 和工具执行上下文同时接收同一个 signal：

```text
REPL AbortController
  → Agent.runWithHistory
    → ModelProvider.complete → fetch / SSE reader
    → ToolRegistry.execute
      → runCommand / searchCode / Git subprocess
```

- `fetch` 直接使用 signal；取消后主动 cancel SSE reader；
- 所有 `Bun.spawn` 子进程监听 signal 并调用 `kill()`；
- 命令自身 timeout 与用户 signal 合并，但返回时区分 `timedOut` 和 `cancelled`；
- 文件写入等短操作在执行前检查 signal，不尝试中断正在进行的单次原子写入。

### 2.2 REPL 行为

- 空闲提示符按 Ctrl-C：退出 REPL；
- Agent 运行中第一次 Ctrl-C：调用当前 AbortController，显示 `Cancelling current turn...`；
- 取消完成后回到 `you>`，保留已完成工具操作和最新检查点；
- 连续第二次 Ctrl-C 可强制退出；
- 增加 `agent_cancelled` 事件，取消不作为普通错误堆栈展示。

## 3. 细粒度检查点与恢复

当前 session 只在一整轮成功后保存。改为在以下时机调用 `onCheckpoint`：

1. user message 加入历史后；
2. assistant response 完成后；
3. 每个 tool result 加入后；
4. 正常完成、取消或失败时。

### 3.1 Session schema v2

```ts
interface StoredSessionV2 {
  version: 2;
  id: string;
  state: "idle" | "running" | "cancelled" | "failed";
  activeRunId?: string;
  updatedAt: string;
  messages: Message[];
  usage: TokenUsage;
}
```

- 保持读取 v1 文件并迁移为 v2 的兼容能力；
- 继续使用临时文件加 rename 原子保存；
- 同一 session 加入进程内写入队列，防止快速检查点乱序覆盖；
- `.andi-agent/` 继续禁止模型文件工具访问。

### 3.2 不完整历史修复

加载 `running`、`cancelled` 或 `failed` session 时执行确定性恢复：

- 找到 assistant tool calls 缺少的 tool result；
- 为每个缺失项追加合成失败结果，说明前一次运行被中断、结果未知；
- 追加 system recovery note，禁止模型假设未记录的工具成功；
- 不自动回滚文件或 Git 状态；要求 Agent 重新读取状态后再行动。

## 4. Token 与耗时统计

新增统一类型：

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
```

- 非流式响应读取 `usage.prompt_tokens/completion_tokens/total_tokens`；
- SSE 请求启用兼容的 usage chunk，并容忍服务端不返回 usage；
- `model_completed` 事件增加 `durationMs` 和可选 usage；
- `AgentRunResult` 返回本轮累计 usage；session 保存累计 usage；
- 不硬编码 Agnes 价格，避免价格变化导致错误成本；后续可通过可配置费率计算费用。

REPL 命令：

- `/status`：session、消息数、当前状态、最近一次运行 ID；
- `/usage`：本轮与 session 累计 token、模型请求次数和耗时；
- `/recover`：重新检查并修复当前历史中的不完整工具调用。

## 5. 结构化运行日志

新增可选 `--log-events`，将不含 API Key 的结构化事件写入：

```text
.andi-agent/runs/<run-id>.jsonl
```

记录 run/turn/tool 的开始、结束、取消、耗时和 token usage。默认不写入 prompt、文件内容或工具完整输出；只记录工具名称、成功状态和截断后的错误摘要。日志仍可能包含项目元数据，应保持在 `.andi-agent/` 内。

## 6. 预计代码变化

```text
src/
├── agent.ts                  # signal、checkpoint、usage 聚合
├── repl.ts                   # active run、取消和新命令
├── session.ts                # schema v2、迁移、恢复、写入队列
├── runtime/
│   ├── abort.ts              # AbortError、signal/timeout 辅助函数
│   └── recorder.ts           # JSONL 事件记录
├── model/
│   ├── types.ts              # TokenUsage、signal
│   └── openai-compatible.ts  # fetch/SSE 取消和 usage 解析
└── tools/
    ├── types.ts              # ToolExecutionContext
    ├── registry.ts           # 传递 signal
    ├── command.ts            # timeout 与 cancel 区分
    ├── search.ts             # 取消 rg
    └── git.ts                # 取消 Git 子进程
```

## 7. 实施顺序

1. 定义 Abort、usage、checkpoint 类型，不改变现有行为。
2. 将 signal 贯穿 ModelProvider、Agent、ToolRegistry 和全部长运行工具。
3. 实现 REPL active-run 状态与 Ctrl-C 取消。
4. 升级 SessionStore v2，加入 v1 迁移和串行检查点写入。
5. 实现不完整工具调用恢复算法。
6. 解析普通响应和 SSE usage，聚合到事件与 session。
7. 增加 `/usage`、`/recover` 和可选 JSONL recorder。
8. 更新 README、`.env.example` 和 AGENTS.md（若工作流发生变化）。

## 8. 测试计划

- 模型请求取消会中止 fetch 和 SSE reader；
- 命令、ripgrep 和 Git 子进程收到 signal 后退出，且标记 `cancelled: true`；
- timeout 仍标记 `timedOut: true`，不与用户取消混淆；
- 取消发生在两个工具调用之间时，不再启动后续工具；
- 每种 checkpoint 时机都有顺序断言；
- v1 session 能迁移，v2 session 能往返保存；
- 缺失 tool result 被补齐且不会重复补齐；
- session 并发保存遵循调用顺序；
- SSE usage 缺失时正常工作，存在时正确累计；
- REPL 取消后可继续下一条任务；空闲 Ctrl-C 正常退出；
- 事件日志不包含 API Key、prompt 或工具完整输出。

## 9. 验收标准

- 任意长运行模型请求或子进程可在 1 秒内响应取消；
- 取消后无遗留子进程，REPL 可继续使用；
- 模拟每个检查点后的崩溃都能加载 session；
- 恢复后的消息序列满足模型 tool-call 协议；
- token usage 在普通响应和 SSE 响应中均有测试；
- 旧 session 无需人工修改即可加载；
- `bun test`、`bun run typecheck`、真实 Agnes 取消冒烟测试全部通过。

## 10. 非目标与后续路线

本阶段不实现自动文件回滚、Git reset、模型自动摘要或语义代码索引。建议后续顺序：

1. 第七阶段：模型驱动的上下文摘要与 token 预算；
2. 第八阶段：AST/LSP 定义、引用和诊断工具；
3. 第九阶段：可插拔 MCP 工具与权限声明；
4. 第十阶段：TUI、并行任务与多 Agent 调度。

## 11. 实现结果

- `AbortSignal` 已贯穿 REPL、Agent、Agnes fetch/SSE、工具注册表和子进程；
- session schema v2 支持原子检查点、进程内串行写入、v1 迁移和中断修复；
- `/usage`、`/recover`、`--log-events` 已接入 CLI；
- 自动化测试覆盖活跃 SSE/子进程取消、检查点、usage 聚合、恢复幂等与日志脱敏。
