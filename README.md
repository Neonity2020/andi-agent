# andi-agent

一个使用 Bun + TypeScript 构建的最小 coding agent。默认使用 Agnes 2.5 Flash，并包含可替换的模型适配层、工具调用循环、工具注册表，以及受工作区边界保护的文件工具。

## 快速开始

要求：已安装 [Bun](https://bun.sh/) 和 [ripgrep](https://github.com/BurntSushi/ripgrep)（用于 `search_code`）。

```bash
bun install
cp .env.example .env
# 编辑 .env，填写 AGNES_API_KEY
bun run start -- --cwd . "阅读 README，并创建一个简短的项目摘要"
```

Bun 会自动加载 `.env`。默认调用 Agnes OpenAI-compatible Chat Completions 接口：

- 模型：`agnes-2.5-flash`
- Base URL：`https://apihub.agnes-ai.com/v1`
- Endpoint：`POST /chat/completions`

如需切换其他兼容服务，可覆盖 `AGENT_BASE_URL` 和 `AGENT_MODEL`。`AGENT_API_KEY` 仍作为通用 API Key 变量兼容保留，但 Agnes 测试建议使用 `AGNES_API_KEY`。

## 命令

```bash
bun run start -- --help
bun run typecheck
bun test
```

### 常驻 REPL

启动一个进程内持续运行的编程会话：

```bash
bun run start -- --repl --session real-dev --approval ask
```

也可以在启动时直接给出第一条任务：

```bash
bun run start -- --repl --session real-dev "分析项目并提出下一步计划"
```

REPL 会复用同一个 Agent、工具和审批终端。消息、模型回复和工具结果都会写入检查点；单轮 API、工具错误或用户取消不会退出。运行中按一次 Ctrl-C 会取消当前轮并返回提示符，空闲时按 Ctrl-C 则退出。内置命令：

- `/help`：显示帮助；
- `/status`：显示 session 和消息数量；
- `/usage`：显示最近一轮及当前 session 的 token 和模型耗时；
- `/recover`：补齐中断留下的缺失 tool result；
- `/clear`：清空内存及持久化历史；
- `/exit` 或 `/quit`：退出。

不指定 `--session` 时仍可在当前进程内多轮交流，但退出后不会保存历史。

### 会话

使用安全的 session ID 保存和恢复多轮上下文：

```bash
bun run start -- --session feature-auth "分析认证模块"
bun run start -- --session feature-auth "继续实现刚才提出的第一项改进"
```

会话以 v2 格式明文保存在 `.andi-agent/sessions/`，不会提交到 Git，也不会出现在 `list_files` 中。旧 v1 会话会自动迁移；加载被中断的会话时，缺失的工具结果会被标记为失败，Agent 会被要求重新读取工作区和 Git 状态。历史超过 `AGENT_MAX_CONTEXT_CHARS` 后，Agent 会按完整用户轮次丢弃最旧内容。

### 定时任务

定时任务保存在当前工作区的 `.andi-agent/schedules.json`。支持一次性时间和固定间隔：

```bash
# 每 24 小时运行；duration 支持 s、m、h、d，最短 10s
bun run start -- schedule add nightly --every 24h --session nightly -- "运行测试并修复失败"

# 一次性任务必须提供带 Z 或明确时区偏移的 ISO 8601 时间
bun run start -- schedule add release-check --at 2026-08-20T09:00:00+08:00 -- "检查发布状态"

bun run start -- schedule list
bun run start -- schedule run nightly
bun run start -- schedule remove nightly
```

创建、查看和删除任务不需要 API Key。要让任务自动到期运行，需要保持 scheduler 进程常驻：

```bash
bun run start -- scheduler
```

后台任务使用独立 session，强制采用非交互审批，并始终写入脱敏 JSONL 运行日志。安全验证命令仍可自动运行，其他命令和 Git 写入会被拒绝。任务全局串行执行；错过多个周期只补跑一次。调度采用 at-most-once 策略：任务启动前即推进下一次时间，进程崩溃后不会自动重复可能有副作用的操作。Ctrl-C 会停止 scheduler 并取消当前运行。

在单次对话或 REPL 中，Agent 也可以直接调用 `schedule_add`、`schedule_list`、`schedule_remove` 和 `schedule_run`。例如：

```text
you> 创建一个每 24 小时运行的任务，ID 为 daily-check，检查类型和测试，但不要提交 Git
you> 列出当前所有定时任务
you> 立即运行 daily-check
you> 删除 daily-check
```

一次性时间必须包含完整日期、时间和时区；信息不完整时 Agent 会先要求确认。固定间隔从创建时刻开始计算，首版暂不支持“每天上午 9 点”一类基于墙上时钟的 cron 规则。

### 命令审批

安全验证命令自动执行。其他命令在默认的 `--approval ask` 模式下会显示完整参数并等待确认：

```text
Approve command ["bun","install"]? [y/N]
```

自动化或非交互环境建议显式使用 `--approval never`，此时所有白名单外命令都会拒绝：

```bash
bun run start -- --approval never "运行现有测试并修复失败"
```

Agent 的轮次、工具执行和上下文裁剪事件写到 stderr，最终回答写到 stdout，便于分别重定向。

如需保留不含 prompt、文件内容和完整工具输出的结构化运行记录，可添加 `--log-events`：

```bash
bun run start -- --repl --session real-dev --log-events
```

日志按 run ID 写入 `.andi-agent/runs/*.jsonl`。其中包含轮次、工具名称、成功状态、耗时和可用的 token usage；该目录仍可能包含项目元数据，应按敏感本地状态处理。

### 流式输出

CLI 默认通过 Agnes Chat Completions SSE 接口增量输出模型文本。工具调用参数即使被拆到多个网络 chunk，也会在执行前完整拼装和校验。作为库使用时，如果没有提供文本 delta 回调，适配器仍使用普通 JSON 响应。

### 代码搜索与 Git

`search_code` 使用 ripgrep 搜索代码，默认按固定字符串匹配，并跳过 `.git`、`.andi-agent` 和 `node_modules`。

Agent 可以直接查看 `git_status` 和 `git_diff`。`git_stage` 只接受明确文件路径，`git_commit` 只提交已暂存内容；两者都要求终端审批，不会自动 push：

```bash
bun run start -- --session feature-auth "检查当前修改；如果测试通过，展示 diff 并提交，提交信息为 feat: finish auth"
```

配置好 `AGNES_API_KEY` 后，可运行真实 Agnes 工具调用冒烟测试：

```bash
bun run test:live
```

这个测试要求模型调用 `read_file` 读取 `package.json`，再调用 `run_command` 执行 `bun run typecheck`，不会修改工作区文件。成功时应输出包名 `andi-agent` 并确认类型检查通过。

## 当前能力

- `read_file`：读取工作区内的 UTF-8 文件；
- `list_files`：递归列出工作区文件，跳过 `.git` 和 `node_modules`；
- `write_file`：创建或覆盖工作区内的 UTF-8 文件；
- `edit_file`：仅在旧文本唯一匹配时进行精确替换；
- `run_command`：无 shell 地运行白名单内的测试、检查、构建和只读 Git 命令；
- 路径穿越与符号链接写入防护；
- 命令超时、输出截断、环境变量脱敏；
- Ctrl-C 贯穿模型请求、SSE reader 和长运行子进程的取消链路；
- 终端逐条命令审批和非交互默认拒绝；
- 细粒度检查点、v1/v2 会话迁移及中断恢复；
- token/模型耗时统计与可选 JSONL 事件日志；
- 本地一次性/固定间隔定时任务、持久化状态及常驻 scheduler；
- 按完整交互轮次进行上下文裁剪；
- Agnes SSE token 流式输出与分片工具调用拼装；
- 受限代码搜索以及带审批的 Git 暂存、提交；
- 工具错误回传、最大循环次数限制。

`run_command` 当前仅自动允许 `bun`/`npm` 的预设验证脚本和 `tsc --noEmit`。它不会调用 shell；其他命令需要审批。Git 操作统一使用专用工具，以禁用 external diff、textconv 和 fsmonitor 等仓库扩展。策略细节见 `.plans/002-coding-tools.md` 和 `.plans/004-stream-search-git.md`。

阶段设计文档位于 `.plans/`；定时任务设计见 `.plans/007-scheduled-tasks.md`。
