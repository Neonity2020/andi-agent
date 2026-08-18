# Bun + TypeScript Coding Agent：项目骨架计划

## 1. 目标

构建一个最小但完整的 coding agent CLI 骨架。第一阶段重点不是堆叠功能，而是建立稳定边界，让后续可以独立替换模型、增加工具、接入审批策略，并保持核心 Agent 循环可测试。

完成后应具备：

- 使用 Bun 直接运行 TypeScript；
- 从命令行接收编码任务；
- 通过 OpenAI-compatible Chat Completions 接口调用模型；
- 执行 `read_file`、`list_files`、`write_file` 三个工作区工具；
- 将工具结果反馈给模型，循环直到得到最终答复；
- 所有文件访问都限制在配置的工作区内；
- 核心模块有单元测试，且无需真实 API Key 即可测试。

## 2. 构建思路

### 2.1 分层

```text
CLI / 配置
    ↓
Agent 核心循环
    ├── ModelProvider（模型协议适配）
    └── ToolRegistry（工具定义、校验、执行）
            └── Workspace（路径安全边界）
```

- `cli`：只负责参数、环境变量、依赖装配和进程退出码。
- `agent`：维护消息历史，向模型发起请求，分发工具调用，控制最大迭代次数。
- `model`：定义项目内部统一协议；具体供应商实现位于 adapters，避免核心逻辑依赖 SDK。
- `tools`：每个工具声明名称、描述、JSON Schema 和执行函数；注册表负责查找与错误归一化。
- `workspace`：集中解析路径并阻止目录穿越，工具不自行拼接路径。

### 2.2 第一版模型接口

首个适配器使用标准 `fetch` 调用 Agnes 的 OpenAI-compatible `/chat/completions`，支持 `tool_calls`。配置来自环境变量：

- `AGNES_API_KEY`（必填；兼容通用变量 `AGENT_API_KEY`）
- `AGENT_MODEL`（默认 `agnes-2.5-flash`）
- `AGENT_BASE_URL`（默认 `https://apihub.agnes-ai.com/v1`）

项目内部不会泄露供应商响应结构；适配器将其转换为统一的 `AssistantTurn`。

### 2.3 工具安全边界

- 相对路径始终以 `--cwd` 指定的工作区为根；
- 拒绝解析后落在工作区之外的路径；
- `write_file` 自动创建目标文件的父目录，但不允许覆盖工作区外文件；
- `list_files` 限制返回数量，跳过 `.git` 和 `node_modules`；
- 骨架阶段不提供 shell 工具，避免未经审批执行任意命令。后续 shell 工具应单独引入命令策略和用户审批层。

### 2.4 错误与终止

- 未配置 API Key、参数无效：CLI 立即失败并给出可操作提示；
- 未知工具、参数解析失败、工具执行失败：作为工具结果返回模型，由模型决定修正；
- 达到最大迭代次数仍未结束：抛出明确错误，避免无限循环；
- HTTP 非 2xx 或响应格式异常：在适配器层给出上下文清晰的错误。

## 3. 目录结构

```text
.
├── .plans/001-project-skeleton.md
├── src/
│   ├── agent.ts
│   ├── cli.ts
│   ├── config.ts
│   ├── index.ts
│   ├── model/
│   │   ├── openai-compatible.ts
│   │   └── types.ts
│   └── tools/
│       ├── registry.ts
│       ├── types.ts
│       └── workspace.ts
├── test/
│   ├── agent.test.ts
│   └── workspace.test.ts
├── .env.example
├── .gitignore
├── README.md
├── bunfig.toml
├── package.json
└── tsconfig.json
```

## 4. 实施步骤

1. 初始化 Bun/TypeScript 元数据、脚本、严格类型检查与忽略规则。
2. 定义模型消息、工具调用、模型适配器等内部类型。
3. 实现工具注册表和安全工作区路径解析。
4. 实现三个基础文件工具。
5. 实现 Agent 工具调用循环及迭代上限。
6. 实现 OpenAI-compatible HTTP 适配器。
7. 实现 CLI 参数解析、环境配置与依赖装配。
8. 编写 README 和环境变量示例。
9. 使用 fake model 为 Agent 循环写测试，并测试目录穿越防护。
10. 执行格式检查、类型检查和测试，修复发现的问题。

## 5. 验收标准

- `bun test` 全部通过；
- `bun run typecheck` 无类型错误；
- `bun run src/cli.ts --help` 能展示帮助；
- Agent 测试能完成一次“模型请求工具 → 工具执行 → 模型最终回复”的闭环；
- `../` 和绝对路径无法越过工作区边界；
- README 能指导用户在五分钟内配置并运行项目。

## 6. 暂不包含

- 任意 shell 命令执行与交互式审批；
- 流式输出、会话持久化和上下文压缩；
- Git 专用工具、代码搜索/补丁工具；
- MCP、LSP、多 Agent 调度；
- 多供应商专有协议适配。

这些功能将在核心闭环稳定后按独立模块增量加入。
