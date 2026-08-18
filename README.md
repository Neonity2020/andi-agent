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

### 会话

使用安全的 session ID 保存和恢复多轮上下文：

```bash
bun run start -- --session feature-auth "分析认证模块"
bun run start -- --session feature-auth "继续实现刚才提出的第一项改进"
```

会话以本地明文保存在 `.andi-agent/sessions/`，不会提交到 Git，也不会出现在 `list_files` 中。历史超过 `AGENT_MAX_CONTEXT_CHARS` 后，Agent 会按完整用户轮次丢弃最旧内容。

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
- 终端逐条命令审批和非交互默认拒绝；
- 结构化运行事件与本地会话恢复；
- 按完整交互轮次进行上下文裁剪；
- Agnes SSE token 流式输出与分片工具调用拼装；
- 受限代码搜索以及带审批的 Git 暂存、提交；
- 工具错误回传、最大循环次数限制。

`run_command` 当前仅自动允许 `bun`/`npm` 的预设验证脚本和 `tsc --noEmit`。它不会调用 shell；其他命令需要审批。Git 操作统一使用专用工具，以禁用 external diff、textconv 和 fsmonitor 等仓库扩展。策略细节见 `.plans/002-coding-tools.md` 和 `.plans/004-stream-search-git.md`。

阶段设计文档位于 `.plans/`：项目骨架、编码工具，以及运行时审批与会话分别记录在 `001`、`002`、`003` 计划中。
