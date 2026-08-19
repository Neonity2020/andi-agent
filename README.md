# andi-agent

一个使用 Bun + TypeScript 构建的最小 coding agent。默认使用 Agnes 2.5 Flash，并包含可替换的模型适配层、工具调用循环、工具注册表，以及受工作区边界保护的文件工具。

## 快速开始

要求：已安装 [Bun](https://bun.sh/) 和 [ripgrep](https://github.com/BurntSushi/ripgrep)（用于 `search_code`）。

```bash
bun install
cp .env.example .env
# 编辑 .env，填写 AGNES_API_KEY；如需联网搜索，再填写 EXA_API_KEY
bun run start -- --cwd . "阅读 README，并创建一个简短的项目摘要"
```

Bun 会自动加载 `.env`。默认调用 Agnes OpenAI-compatible Chat Completions 接口：

- 模型：`agnes-2.5-flash`
- Base URL：`https://apihub.agnes-ai.com/v1`
- Endpoint：`POST /chat/completions`

如需切换其他兼容服务，可覆盖 `AGENT_BASE_URL` 和 `AGENT_MODEL`。`AGENT_API_KEY` 仍作为通用 API Key 变量兼容保留，但 Agnes 测试建议使用 `AGNES_API_KEY`。

### MiniMax 国内版

MiniMax 国内版使用官方 OpenAI 兼容接口。将 `.env` 配置为：

```text
AGNES_API_KEY=your-agnes-key
MINIMAX_API_KEY=your-minimax-key
MINIMAX_MODEL=MiniMax-M2.7
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
```

Agnes 仍是默认 Provider；MiniMax 配置好后，在 REPL 中执行 `/provider minimax` 切换，执行 `/provider agnes` 切回。切换后使用 `/models` 选择该 Provider 的模型；模型目录会独立缓存到当前 workspace 的 `.andi-agent/models.json`，不会混用。

### Exa Web Search

在 `.env` 中设置 `EXA_API_KEY` 后，普通对话 Agent 和定时任务 Agent 会获得 `web_search` 工具：

```text
EXA_API_KEY=your-exa-key
EXA_BASE_URL=https://api.exa.ai
```

未配置 Exa Key 时工具不会注册，其他功能不受影响。工具支持查询、1–10 条结果以及可选域名过滤，并返回标题、URL、发布日期、作者和高亮摘要。外部网页内容会作为不可信数据处理；Agent 应忽略网页中的指令，并在答案中引用结果 URL。API 协议依据 [Exa Search API 官方文档](https://exa.ai/docs/reference/search)。

### Weather

Agent 默认提供 `weather` 工具，通过 Open-Meteo 查询城市当前天气和未来三天预报，不需要额外 API Key。调用时传入中文或英文城市名，例如 `{"city":"北京"}`。

### Skills（Claude Code / Codex 兼容）

andi-agent 支持 Agent Skills 开放格式：每个技能是一个目录中的 `SKILL.md`，文件以 YAML frontmatter 开始，至少包含 `name` 和 `description`，正文写工作流或领域约定。例如：

```text
.agents/skills/code-review/SKILL.md
.claude/skills/code-review/SKILL.md
```

项目级技能会从 `.agents/skills/`、`.claude/skills/` 和旧版 `.codex/skills/` 发现；用户级技能会从 `~/.agents/skills/`、`~/.claude/skills/`、`$CODEX_HOME/skills/` 和 `~/.codex/skills/` 发现。相同名称时项目技能优先。`/skills` 列出技能，`/skill-name [args]` 或 `/skill skill-name [args]` 显式调用；普通任务会根据 `description`、`when_to_use` 和技能名自动加载相关技能正文。

兼容 Claude Code 的 `$ARGUMENTS`、`${CLAUDE_SKILL_DIR}`、`disable-model-invocation`、`user-invocable`、`context`、`allowed-tools` 和 ``!`command` `` 动态上下文语法。动态命令通过 andi-agent 现有的命令审批策略执行；没有可用审批器时不会绕过安全限制。

配置 Key 后可手动执行一次真实 API 冒烟测试：

```bash
bun run test:exa
```

## 全局 `andi` 命令

在仓库内执行一次 `bun link`，即可把启动方式注册为全局 `andi` 命令（链接位于 `~/.bun/bin/andi`，需要 `~/.bun/bin` 在 PATH 中）：

```bash
bun link
cd ~/任意项目
andi                      # 在当前 workspace 启动 TUI 交互会话
andi                      # 使用 default session，自动保存并恢复对话
andi --session real-dev   # 使用指定的持久 session 启动
andi --plain              # 使用经典 readline 界面
andi schedule list        # 管理当前 workspace 的定时任务
andi "修复失败的测试"      # 单次任务模式
```

不带任何参数运行 `andi` 等价于 `--repl`，workspace 始终是当前目录。API 配置按优先级解析：shell 环境变量 > 当前目录的 `.env`（Bun 自动加载）> andi-agent 安装目录的 `.env`，因此在其他项目中运行 `andi` 无需重复配置 Key。

### 长期记忆

andi-agent 使用当前 workspace 的 `.memory/` 保存可跨 session 复用的 Markdown 记忆，例如稳定的项目事实、架构决策、工作约定和用户偏好。每轮开始前会进行本地中英文词法检索，最多把 3 篇相关记忆临时注入模型请求；这些内容不会写入 session，也不会为了填满配额加载无关记忆。

交互 Agent 提供 `memory_search`、`memory_read`、`memory_remember` 和 `memory_archive`。更新已有记忆必须携带上次读取到的 `updated` 值，过期写入会被拒绝；归档会移动到 `.memory/archive/`，不会永久删除。定时任务 Agent 只能搜索和读取。通用文件工具不能直接修改 `.memory/`。

REPL 可直接执行 `/memory list`、`/memory search <query>` 和 `/memory show <id>`，这些命令不调用模型。不要在长期记忆中保存 API Key、原始对话、猜测、测试输出或临时运行状态；后者仍存放在已忽略的 `.andi-agent/` 中。

## 命令

```bash
bun run start -- --help
bun run typecheck
bun test
```

### TUI 交互界面

在 TTY 环境下，`--repl`（包括零参数 `andi`）默认启动内联式 TUI：完成的用户输入、助手回复（轻量 Markdown 渲染，支持标题、列表、代码块和表格）和工具结果（`✓ 工具 · 耗时`）会输出到终端原生 scrollback，屏幕底部只保留一个实时区域，显示 spinner、运行中的工具、流式输出预览、输入行（`❯`）和状态栏（模型 · session · 工作区）。

命令审批会在 scrollback 中显示待批准命令，底部以 `approve? [y/N]` 提示：按 `y` 批准，其他任意键拒绝。运行中按 Ctrl-C 取消当前轮，空闲时按 Ctrl-C 退出；输入流关闭（Ctrl-D）也会退出。

输入行支持完整编辑：方向键/Home/End 移动，Alt-B / Alt-F / Ctrl-左右键按词移动，Ctrl-U / Ctrl-K 删除到行首/行尾，Ctrl-W 删除前一个词，↑/↓ 翻阅历史（自动保存草稿），并支持 bracketed paste（多行粘贴合并为一行）。中文与 emoji 按终端单元格宽度正确对齐。设置 `NO_COLOR` 可关闭颜色。

如需回到经典 readline 界面：

```bash
andi --plain
bun run start -- --repl --plain
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

REPL 会复用同一个 Agent、工具和审批终端。消息、模型回复和工具结果都会写入检查点；单轮 API、工具错误或用户取消不会退出。运行中按一次 Ctrl-C 会取消当前轮并返回提示符，空闲时按 Ctrl-C 则退出。`Ctrl-D` 是全局直接退出键，在输入、模型选择、审批或运行状态下都会退出；运行中的请求会先被取消。内置命令：

- `/help`：显示帮助；
- `/status`：显示 session、当前模型和消息数量；
- `/usage`：显示最近一轮及当前 session 的 token 和模型耗时；
- `/models`：从本地模型目录打开 TUI 下拉菜单并搜索、切换；
- `/models refresh`：从当前 Provider 强制刷新模型目录；
- `/recover`：补齐中断留下的缺失 tool result；
- `/clear`：清空内存及持久化历史；
- `/exit` 或 `/quit`：退出。

不指定 `--session` 时，REPL 默认使用当前工作区的 `default` session，退出时保存并在下次运行 `andi` 时恢复。使用 `--session <id>` 可以为不同任务维护独立会话；`/clear` 会清空当前 session。

模型选择器支持直接输入过滤、方向键或 Page Up/Page Down 导航、Enter 确认、Esc 取消。classic plain REPL 会降级为编号/完整 ID 输入。

模型目录保存在 `.andi-agent/models.json`。第一次没有缓存时，`/models` 会向当前 Provider 获取并保存列表；之后直接读取内存或磁盘，不再重复发送网络请求。接入新模型后可用 `/models refresh` 更新当前 Provider，同时保留文件中其他 Provider 的目录。该版本化文件不保存 API Key，并与 session 等运行状态一起被 Git 忽略。

模型切换只影响当前进程中的后续请求，不会修改 `.env` 或已保存的 session；重新启动后仍使用 `AGENT_MODEL`。图像、视频、embedding 等非 Chat Completions 模型不会出现在可选列表中。

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
- `list_files`：递归列出普通工作区文件，跳过 `.git`、`.andi-agent`、`.memory` 和 `node_modules`；
- `write_file`：创建或覆盖工作区内的 UTF-8 文件；
- `edit_file`：仅在旧文本唯一匹配时进行精确替换；
- `run_command`：无 shell 地运行白名单内的测试、检查、构建和只读 Git 命令；
- `web_search`：通过可选 Exa API 搜索当前网络信息并返回可引用来源；
- `memory_search` / `memory_read`：检索和读取跨 session 的长期 Markdown 记忆；
- `memory_remember` / `memory_archive`：受容量、敏感信息和并发保护地维护长期记忆；
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
