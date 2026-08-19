# andi-agent 项目分析报告

- 分析日期：2026-08-19
- 分析范围：全仓库（`src/` 3,144 行 TypeScript，`test/` 1,543 行，共 34 个源文件）
- 验证状态：`bun test` 67 个用例全部通过（2.19s，19 个文件）；`bun run typecheck` 通过；工作区干净（`0f3fa5c`）

## 1. 项目概览

andi-agent 是一个基于 **Bun + TypeScript** 构建的最小化本地 coding agent，当前版本 0.1.0。核心特征：

| 维度 | 内容 |
| --- | --- |
| 运行时 | Bun（ESM，无 Node 兼容负担） |
| 默认模型 | `agnes-2.5-flash`（Agnes OpenAI-compatible Chat Completions） |
| 模型接入 | 可替换的 `ModelProvider` 适配层，支持 SSE 流式输出 |
| 工具 | 14 个模型可调用工具（文件、编辑、搜索、命令、Git、定时任务） |
| 持久化 | 本地明文 session 检查点 + 定时任务注册表（`.andi-agent/`） |
| 依赖 | 运行时仅 `puppeteer`（服务 docs 截图脚本，与 agent 本体无关）；开发依赖仅 `@types/bun` + `typescript` |
| 开发方式 | 8 个阶段计划（`.plans/001`–`008`）驱动，3 个提交，Conventional Commits |

## 2. 目录结构

```
andi-agent/
├── src/
│   ├── cli.ts            # Bun 入口：参数解析、终端 IO、REPL/scheduler 装配（483 行，最大模块）
│   ├── agent.ts          # Agent 循环：轮次、事件、检查点、取消
│   ├── repl.ts           # 持久 REPL：内置命令、Ctrl-C 语义
│   ├── session.ts        # session 持久化：v2 格式、v1 迁移、中断恢复
│   ├── context.ts        # 上下文压缩：按完整用户轮次丢弃
│   ├── config.ts         # 环境变量加载与校验
│   ├── usage.ts          # token/耗时统计
│   ├── index.ts          # 库导出
│   ├── model/            # ModelProvider 接口 + OpenAI-compatible 实现（SSE 流式）
│   ├── tools/            # 工具注册表 + 14 个工具（workspace/editing/search/command/git/scheduler/validation）
│   ├── scheduler/        # 定时任务：parser/store/scheduler/runner/types
│   └── runtime/          # abort（取消错误）、recorder（脱敏 JSONL 日志）
├── test/                 # 19 个测试文件，镜像 src 结构
├── .plans/               # 8 个阶段设计文档
└── docs/                 # 生成产物沙盒（HTML、截图等）
```

## 3. 架构分析

整体分层清晰，依赖单向：`cli/repl → agent → (model + tools)`，scheduler 作为独立子系统复用 agent。

### 3.1 Agent 循环（`src/agent.ts`）

`Agent.runWithHistory` 是核心循环：每轮先做上下文压缩，再调 `model.complete`（流式增量输出），拿到 tool calls 后逐个执行并把 JSON 结果回填为 `tool` 消息，直到模型不再发起调用。要点：

- **事件系统**：9 种 `AgentEvent`（轮次开始/完成、文本增量、工具开始/完成、压缩、结束/取消/失败），驱动终端渲染、usage 统计和 JSONL 日志。
- **检查点**：每轮、每个工具结果后都通过 `onCheckpoint` 落盘，状态机为 `running → idle | cancelled | failed`，是会话中断恢复的基础。
- **护栏**：`maxTurns`（默认 12）防止死循环；空任务直接抛错。
- **取消链路**：`throwIfAborted` 贯穿模型请求、每个工具调用；取消与失败在 catch 中区分并各自落检查点。

### 3.2 模型层（`src/model/`）

`OpenAICompatibleProvider` 是唯一实现，接口 `ModelProvider.complete` 只有 21 行，替换成本低。SSE 流式解析（`parseStreamingResponse`）做对了几个细节：工具调用参数跨网络 chunk 按 `index` 累积拼装、`[DONE]` 哨兵、流内 error payload 转异常、usage 兼容 `prompt_tokens`/`input_tokens` 两套字段名。未提供 `onTextDelta` 时自动退回普通 JSON 响应，方便作为库使用。

### 3.3 工具层（`src/tools/`）

`ToolRegistry` 负责注册去重、schema 导出和参数 JSON 解析，工具异常被隔离为 `{ok: false, error}` 回传给模型（取消错误除外，会向上传播终止整轮）。14 个工具：

| 类别 | 工具 | 说明 |
| --- | --- | --- |
| 文件 | `read_file` / `list_files` / `write_file` | 工作区内 UTF-8 读写，递归列表限 200 条 |
| 编辑 | `edit_file` | 精确替换，要求 `old_text` 全文唯一匹配 |
| 搜索 | `search_code` | ripgrep 子进程，默认固定字符串，排除 `.git`/`.andi-agent`/`node_modules` |
| 命令 | `run_command` | 无 shell 直 exec，白名单外需审批或拒绝 |
| Git | `git_status` / `git_diff` / `git_stage` / `git_commit` | 读操作直接执行，写操作强制审批，禁用仓库扩展 |
| 调度 | `schedule_add` / `schedule_list` / `schedule_remove` / `schedule_run` | Agent 在对话中直接管理本地定时任务 |

### 3.4 会话持久化（`src/session.ts`）

- v2 JSON 格式（state/activeRunId/messages/usage），v1 读取时自动迁移。
- 原子写：临时文件 + `rename`；每个 session 一条写 Promise 队列，避免并发写交错。
- **中断恢复**：加载非 idle 会话时，`repairIncompleteToolCalls` 为缺失结果的 tool call 补上失败消息（否则 API 会拒绝对话），并注入恢复提示要求 Agent 重读工作区状态。

### 3.5 REPL（`src/repl.ts`）

进程内多轮会话，复用同一个 Agent 和审批终端。内置 `/help` `/status` `/usage` `/recover` `/clear` `/exit`。Ctrl-C 语义明确：运行中取消当前轮回到提示符，空闲时退出。每轮通过 `saveCheckpoint` 增量持久化，session usage 跨轮累计。

### 3.6 定时任务子系统（`src/scheduler/`）

- **parser**：CLI 与工具共用的参数校验。一次性时间必须是带时区的 ISO 8601（正则 + 日历合法性双重校验，拒绝过去时间）；间隔 10s–365d。
- **store**：`.andi-agent/schedules.json` 注册表，读入时全量结构校验（`isScheduledTask`），原子写 + 串行队列。
- **scheduler**：1s 轮询。采用 **at-most-once** 策略——任务启动前先推进 `nextRunAt` 再执行，进程崩溃不会重复有副作用的操作；全局串行执行；错过多个周期只补跑一次（`nextScheduleState` 按间隔数跳跃）。启动时 `recoverInterrupted` 把遗留 `running` 状态标记为 failed。
- **runner**：为每次运行组装独立 Agent + 独立 session，**无 approver**（即非交互模式，白名单外命令默认拒绝），运行事件始终写脱敏 JSONL；失败时把 runId 附加到错误对象供调度层记录。

### 3.7 运行时支撑

- `runtime/abort.ts`：统一的取消错误判断。
- `runtime/recorder.ts`：事件日志，跳过文本增量，对 `agent_failed` 的错误信息做 Bearer/api-key 正则脱敏并截断 300 字符。
- `context.ts`：压缩按「完整用户轮次」分组从旧到新丢弃，保留全部 system 消息，并插入压缩提示；始终保持至少一个轮次。
- `config.ts`：环境变量集中校验（key 缺失、数值非法均给出明确报错）。

## 4. 安全设计

这是项目最扎实的部分，防线层层叠加：

1. **路径边界**：词法检查（`relative` 前缀判断）+ `realpath` 规范化双重校验；读取必须解析到工作区内。写入防 symlink 逃逸最完整——先校验最近存在祖先目录的规范路径，mkdir 后再校验父目录规范路径，最后 `lstat` 拒绝写入符号链接本身（`src/tools/workspace.ts:64-91`）。
2. **`.andi-agent/` 隔离**：所有文件类工具经 `assertToolPath` 拒绝访问内部状态目录；`list_files` 与 `search_code` 也排除它，防止 session/日志中的敏感内容进入模型上下文。
3. **命令执行**：无 shell、参数数组直 exec；白名单仅 `bun|npm test`、`bun|npm run {test,typecheck,lint,check,build}`、`tsc --noEmit`；其余命令走终端审批（`--approval ask`）或直接拒绝（`--approval never` / 后台任务）。
4. **环境脱敏**：子进程只继承 `PATH/LANG/LC_ALL/TERM/TMPDIR/CI` 白名单，API key 不会泄漏给任意命令。
5. **资源限制**：命令超时 1–120s、输出 64KB 截断；搜索限 500 结果、每文件 5 个匹配；列表 200 条。
6. **Git 防护**：`--no-pager`、`--no-ext-diff`、`--no-textconv`、`core.fsmonitor=false` 阻断 external diff/textconv 注入；拒绝 pathspec magic（`:` 前缀）和 `.`；禁止目录 staging；commit message 单行 ≤200 字符；stage/commit 强制审批；不提供 push。
7. **输入校验**：session ID / task ID 正则 `[A-Za-z0-9_-]{1,64}`；持久化 JSON 读取时全量结构校验而非信任落盘内容；工具参数逐字段类型检查。

## 5. 测试与质量

- 67 个用例、19 个文件全部通过，覆盖面与源码结构一一对应：agent 循环/取消/压缩、SSE 流式与分片工具调用、每个工具的成功与安全边界（路径穿越、symlink、命令注入、pathspec magic）、session 迁移与中断恢复、scheduler 的解析/存储/调度/CLI/工具。
- 验证均在本机复现通过：`bun test`（67 pass / 0 fail）、`bun run typecheck`。
- 不足：无覆盖率工具、无 CI 流水线、无 lint/formatter（AGENTS.md 已声明靠人工对齐）。

## 6. 优点总结

- **分层干净、依赖单向**：模型与工具都是接口 + 注册表，替换或单测注入容易；测试里能用 stub 模型跑完整循环就是证明。
- **防御性编程一致**：所有外部输入（模型产出的工具参数、磁盘上的 JSON、CLI 参数、SSE chunk）一律运行时校验，从不信任。
- **持久化模式统一**：tmp + rename 原子写、按 key 串行队列，session 和 schedule 两处一致。
- **取消是第一公民**：从 Ctrl-C 到模型请求、SSE reader、子进程的传播链路完整，且区分用户取消与失败两条路径。
- **文档与实现同步**：README 的行为描述与代码逐条对应，`.plans/` 保留了设计决策依据。

## 7. 潜在问题与改进建议

按影响排序：

1. **SSE chunk 无容错**（`src/model/openai-compatible.ts:105`）：`JSON.parse(data)` 直接解析，单个畸形 chunk 会抛 SyntaxError 导致整轮失败。建议 try/catch 后跳过或按可配置策略重试。
2. **事件日志重复全量重写**（`src/runtime/recorder.ts:17`）：每个事件都把该 run 的全部累积行重新写一遍，长会话下是 O(n²) 的 IO 放大。建议追加写（记录文件偏移）或至少按事件类型降频。
3. **Git 读命令无超时**（`src/tools/git.ts:14-38`）：`runGitRead` 的 `timedOut` 恒为 `false`，挂起的 git 进程只能靠取消信号兜底。建议复用 `runCommand` 的超时机制。
4. **`cli.ts` 职责过重**（483 行）：参数解析、终端 IO、审批交互、REPL 装配、scheduler CLI、事件渲染混在一起，是全仓最大的模块。后续加功能前建议先拆出 `terminal.ts` 与 `events-renderer.ts`。
5. **puppeteer 放错依赖组**：只有 `docs/screenshot.mjs` 用到，却在 `dependencies`，导致生产安装也拉 Chromium。建议移到 `devDependencies`。
6. **工程化缺口**：建议补 GitHub Actions（`bun test` + `typecheck`）、覆盖率统计（`bun test --coverage`）和 biome/oxlint。
7. **小项**：`compactMessages` 每轮对所有消息重复 `JSON.stringify` 计算体积，超长会话有开销，可缓存消息大小；symlink 检查与写入之间存在理论上的 TOCTOU 窗口（本地单用户场景可接受，多进程并发写同一工作区时需注意）。

## 8. 总结

andi-agent 用约 3,100 行源码实现了一个结构完整、安全边界严密的本地 coding agent：模型层可替换、工具层可扩展、会话可恢复、任务可调度，且取消、审批、脱敏、输出限制等运维细节都有交代。测试与类型检查当前全绿。主要的提升空间不在功能，而在健壮性细节（SSE 容错、日志 IO、Git 超时）和工程化配套（CI、lint、依赖分组）。
