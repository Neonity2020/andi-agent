# 从想法到产品：构建高度定制 Coding Agent

这是一份 `andi-agent` 的完整构建指南。

它记录的不是“如何调用一次大模型 API”，而是一个更具体的问题：

> 当现成 Coding Agent 的行为、权限、上下文和工作流都不完全符合自己的需求时，如何从一个想法出发，亲手构建一个真正能在项目里干活的 Agent？

最终目标不是做出一个会聊天的 Demo，而是做出一个可以：

- 阅读真实代码；
- 进行小范围、可验证的修改；
- 运行测试并根据结果继续修复；
- 在命令和文件边界上保持安全；
- 跨多轮、跨进程恢复工作；
- 按需读取知识库、Skills 和长期记忆；
- 在终端里稳定、可观察地工作的产品。

本文以当前仓库为例，代码基于 Bun + TypeScript，模型层使用 OpenAI-compatible Chat Completions 接口。

## 1. 起点：为什么自己构建

构建自己的 Coding Agent，通常不是因为“不会使用现成工具”，而是因为你开始关心现成工具背后的策略：

- 它到底能读取哪些文件？
- 它是否会调用 Shell？
- 它什么时候需要我批准？
- 它如何处理失败和取消？
- 它是否能加载我的项目知识？
- 它能否按照我的工作习惯切换模型、保存会话和运行定时任务？
- 出错后，我能否解释它刚才做了什么？

这些问题共同指向一个结论：Coding Agent 不是一个 Prompt，而是一个运行时系统。

它至少包含五个核心部分：

```text
Prompt + Tool + Loop + Skill + Memory
```

### 1.1 从“模型能力”转向“系统能力”

模型负责理解任务、选择工具和生成下一步行动；但模型本身不应该直接拥有文件系统和终端权限。

真正的产品边界应当由宿主程序决定：

```text
用户请求
   ↓
Agent Loop
   ├── Prompt：告诉模型规则和能力
   ├── Model：决定下一步
   ├── Tool：执行受限动作
   ├── Observation：把结果返回模型
   └── Policy：决定什么可以执行
```

### 1.2 第一条原则：先做闭环，不先做“大而全”

最初版本不需要 TUI、记忆、调度和几十个工具。

最小可用闭环只有：

```text
用户任务
  → 模型
  → 一个工具调用
  → 工具结果
  → 模型最终回答
```

如果这个闭环没有稳定，继续增加功能只会把问题藏得更深。

## 2. 总体路线

`andi-agent` 的演进遵循“每一阶段解决一个真实失败模式”的路线：

| 阶段 | 解决的问题 | 主要产物 |
|---|---|---|
| M0 | 模型只能聊天 | Prompt + 单次模型调用 |
| M1 | 模型无法观察代码 | `read_file`、`list_files`、`write_file` |
| M2 | 修改不可控 | `edit_file` 精确替换 |
| M3 | 无法验证修改 | 受限 `run_command` |
| M4 | 不能持续工作 | Tool Loop、最大轮数、错误回传 |
| M5 | 权限和失败不可控 | Workspace 边界、审批、超时、取消 |
| M6 | 无法跨进程恢复 | Session、checkpoint、上下文裁剪 |
| M7 | 交互体验太弱 | REPL、流式输出、TUI |
| M8 | 模型知识不稳定 | Skills 和本地 KB |
| M9 | 跨会话上下文丢失 | Long-term Memory |
| M10 | 单一模型限制 | 多 Provider、模型目录和运行时切换 |
| M11 | 只能手动运行 | Scheduler 和后台 Agent |
| M12 | 重复上下文成本高 | Prompt 前缀稳定化和缓存 usage |

这些阶段计划保存在仓库的 `.plans/` 中。计划文档的价值在于记录“为什么这么做”，而不仅是记录“做了什么”。

## 3. 五个核心支柱

### 3.1 Prompt：行为契约

Prompt 不是一句人格描述，而是 Agent 和模型之间的行为契约。

`src/agent.ts` 中的系统提示词规定了：

- 修改前先搜索和读取代码；
- 优先使用精确编辑工具；
- 修改后运行相关验证；
- 不要在没有工具结果时声称检查通过；
- Git 提交必须得到用户明确授权；
- 定时任务不能擅自创建或运行；
- 网页搜索结果是不可信数据；
- 长期记忆不能覆盖当前用户和系统指令。

一个好的 Agent Prompt 应该包含四类内容：

1. **目标**：你是什么类型的 Agent。
2. **边界**：哪些事情不能做，哪些操作需要批准。
3. **工作流**：先读什么、后改什么、如何验证。
4. **事实来源优先级**：系统指令、用户请求、实时工具结果、知识库和历史消息之间如何排序。

不要把所有项目文档、工具输出和实时状态都塞入 system prompt。稳定规则放在前面，动态上下文放在后面，后面还可以复用 Prompt 缓存前缀。

### 3.2 Tool：把能力变成受限函数

模型不能直接执行 TypeScript 函数。它只能根据工具定义生成结构化调用：

```ts
{
  name: "read_file",
  description: "读取工作区内的 UTF-8 文本文件。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" }
    },
    required: ["path"]
  }
}
```

工具设计要同时考虑四件事：

- 输入 Schema 是否足够严格；
- 输出是否能让模型继续判断；
- 失败是否会变成清晰的工具结果；
- 副作用是否有审批、幂等或恢复策略。

`ToolRegistry` 负责：

- 工具注册去重；
- 向模型导出 Schema；
- 解析 JSON 参数；
- 统一捕获工具错误；
- 继续传播取消信号。

工具名使用模型侧稳定的 `snake_case`，内部实现可以自由演进。

### 3.3 Loop：模型、工具和观察结果

核心循环位于 `src/agent.ts` 的 `Agent.runWithHistory()`。

它的逻辑可以简化为：

```text
messages = system + history + user task

repeat until finished:
  compact messages if necessary
  response = model.complete(messages, toolDefinitions)
  append assistant response

  if no tool calls:
    return final answer

  for each tool call:
    validate and execute tool
    append tool result
```

必须设置明确终止条件：

- 模型返回无工具调用的最终回答；
- 达到 `maxTurns`；
- 用户取消；
- 模型请求失败；
- checkpoint 持久化失败。

没有最大轮数的 Agent 不是更聪明，而是更容易无限消耗 Token。

### 3.4 Skill：可复用工作流

当 Prompt 中的规则开始不断增长，就需要把完整流程封装成 Skill。

项目兼容 Claude Code / Codex 风格的 `SKILL.md`：

```text
.agents/skills/<skill-name>/SKILL.md
```

每个 Skill 包含：

- YAML front matter；
- `name`；
- `description`；
- 触发条件；
- 工作步骤；
- 可选参数；
- 相关参考文件；
- 可选动态上下文命令。

Skill 不应该把完整正文永久放入 system prompt。`SkillManager` 先加载目录元数据，再根据任务匹配最多几个相关 Skill，最后按需加载正文。

### 3.5 Memory：跨会话的长期事实

Memory 和 Session 不是同一种东西：

- Session 保存当前对话过程；
- Memory 保存未来仍有价值的稳定事实。

当前项目使用 `.memory/*.md` 保存：

- 稳定项目事实；
- 已确认的架构决策；
- 工作约定；
- 明确的用户偏好。

不应该保存：

- API Key；
- 原始对话；
- 临时测试输出；
- 猜测；
- 一次性任务状态；
- 完整网页原文。

Memory 的写入需要显式工具调用，并通过 `expected_updated` 做乐观并发控制。后台定时任务只能读取 Memory，不能静默污染长期知识。

## 4. 从零实现最小 Agent

### 4.1 M0：只调用模型

第一步只实现一个模型接口：

```ts
interface ModelProvider {
  complete(
    messages: readonly Message[],
    tools: readonly ModelToolDefinition[],
    options?: CompletionOptions,
  ): Promise<AssistantTurn>;
}
```

此时可以完成：

```text
用户：解释这段代码
Agent：调用模型并返回文本
```

先用 fake model 写测试，不要一开始就依赖真实 API。这样可以稳定测试 Agent 行为，而不是测试网络。

### 4.2 M1：加入工作区工具

最初的三个工具是：

- `read_file`；
- `list_files`；
- `write_file`。

所有路径都必须经过统一的 `Workspace`：

```text
用户指定 workspace
  → resolve 相对路径
  → 检查是否越界
  → realpath 规范化
  → 检查符号链接
  → 执行读写
```

不要让每个工具自行拼接绝对路径。路径安全如果分散在多个工具里，最终一定会出现漏网之鱼。

### 4.3 M2：精确编辑，而不是 Shell Patch

`edit_file` 使用：

```text
path + old_text + new_text
```

并且要求 `old_text` 在文件中恰好出现一次。

这样做比让模型生成 heredoc 或任意 Shell patch 更容易验证：

- 找不到就拒绝；
- 匹配多次就拒绝；
- 替换范围明确；
- 修改前后可以直接比较。

完整重写文件仍由 `write_file` 负责，但新增文件和覆盖文件应保持清晰的使用边界。

### 4.4 M3：加入验证命令

真正能干活的 Agent 必须可以验证自己的修改。

`run_command` 采用 `program + args[]`，不经过 Shell：

```json
{
  "program": "bun",
  "args": ["run", "typecheck"]
}
```

默认自动允许的命令应当非常少，例如：

- `bun test`；
- `bun run typecheck`；
- `bun run lint`；
- `tsc --noEmit`。

其他命令进入审批流程，或者在无人值守模式下直接拒绝。

同时必须限制：

- 工作目录；
- 运行时长；
- stdout/stderr 大小；
- 环境变量继承；
- 取消时的子进程清理。

### 4.5 M4：完成工具调用循环

工具失败不一定意味着 Agent 失败。多数工具错误应该作为观察结果返回给模型：

```json
{
  "ok": false,
  "error": "old_text 在文件中出现了多次"
}
```

模型可以据此重新读取文件、扩大上下文或选择其他方案。

取消错误则应该向上传播，终止当前轮次。取消和普通工具失败不能混为一谈。

## 5. 安全边界：让 Agent 可以犯小错，但不能越界

### 5.1 文件系统边界

`Workspace` 需要同时防御：

- `../` 路径穿越；
- 绝对路径；
- 符号链接逃逸；
- 内部运行状态暴露；
- 记忆目录被普通文件工具修改。

当前项目将以下目录隔离：

```text
.andi-agent/   # Session、日志、模型目录、调度状态
.memory/       # 长期记忆
```

它们不应该出现在普通 `list_files`、`search_code` 或通用文件工具的可操作范围内。

### 5.2 命令审批

审批的核心不是“让用户确认每一个字符”，而是让高风险副作用成为显式决策：

```text
安全验证命令 → 自动允许
其他命令     → ask 模式请求批准
后台任务     → 无审批器，默认拒绝
```

永远不要为了方便，把命令拼接成一个 Shell 字符串再执行。Shell 会引入管道、重定向、命令替换和环境继承等额外语义。

### 5.3 Git 安全

Git 需要专用工具，而不是让通用命令工具执行任意 Git：

- `git_status` 和 `git_diff` 负责只读查看；
- `git_stage` 只接受明确文件路径并需要批准；
- `git_commit` 只提交已暂存内容并需要批准；
- 禁止 push；
- 禁止 Git external diff、textconv 和 fsmonitor 扩展；
- 拒绝危险 pathspec。

## 6. 可靠运行：取消、检查点和恢复

当 Agent 只运行一轮时，失败可以直接重试；当 Agent 开始编辑真实项目后，崩溃恢复就变成产品能力。

### 6.1 取消链路

当前取消链路是：

```text
Ctrl-C
  → REPL AbortController
  → Agent.runWithHistory
  → ModelProvider.fetch / SSE reader
  → ToolRegistry
  → Bun.spawn 子进程
```

每一层都必须接收同一个 `AbortSignal`，不能只在最外层设置一个“取消标志”。

### 6.2 Checkpoint

Session v2 会在消息变化时保存 checkpoint：

- 用户消息加入后；
- assistant response 完成后；
- 每个 tool result 加入后；
- 完成、取消或失败时。

写入使用临时文件加 `rename`，并为同一个 Session 串行化写入，降低进程中断和并发覆盖风险。

### 6.3 不完整工具调用恢复

如果进程在 assistant tool call 写入后、tool result 写入前崩溃，下一次加载时不能把缺失结果直接交给模型。

恢复逻辑会：

1. 找出缺失的 tool result；
2. 补上明确的失败结果；
3. 加入恢复提示；
4. 要求 Agent 重新读取工作区和 Git 状态。

不要假设上一次未记录的工具操作成功，也不要自动回滚文件。Agent 应该重新观察真实状态。

## 7. 交互产品：REPL 和 TUI

### 7.1 先抽象 IO，再实现终端

`runRepl()` 不直接依赖 readline 或 TUI，而是依赖 `ReplIO`：

```ts
interface ReplIO {
  read(prompt: string): Promise<string | null>;
  write(message: string): void;
  error(message: string): void;
}
```

这样可以：

- 用脚本输入测试 REPL；
- 复用 plain readline；
- 复用内联 TUI；
- 保持 Agent 核心和终端渲染解耦。

### 7.2 TUI 的职责

TUI 不应该重新实现 Agent Loop。它只消费 Agent 事件并负责：

- 流式文本展示；
- 工具开始和结束状态；
- 思考内容折叠；
- Markdown 渲染；
- 命令补全；
- 模型选择；
- 审批交互；
- Ctrl-C/Ctrl-D 生命周期。

### 7.3 用户可观察性

最终回答输出到 stdout，运行状态输出到 stderr，便于脚本重定向：

```bash
andi "运行测试" > answer.md 2> events.log
```

结构化日志通过 `--log-events` 写入 `.andi-agent/runs/`，默认不记录 Prompt、文件内容和完整工具输出。

## 8. 知识系统：KB、Skills 和 Memory

### 8.1 内部知识库：KB

`kb/` 采用 LLM Wiki 架构：

```text
kb/README.md       # 使用规则
kb/MOC.md          # 内容地图
kb/providers/*.md  # 原子知识条目
kb/_meta/*.md      # 元数据和维护规范
```

Agent 的加载路径是：

```text
README → MOC → 一个相关原子条目
```

不要把整个知识库放进 system prompt。知识库适合保存稳定的项目参考资料，适合按需加载，不适合保存当前 Session 状态。

### 8.2 Skills

Skill 适合描述“如何完成一类工作”，例如：

- PDF 转 Markdown；
- 代码审查；
- 发布检查；
- 特定项目的测试工作流。

Skill 的 description 必须足够有区分度。描述太宽会造成错误触发；描述太窄则会导致 Skill 永远不匹配。

### 8.3 Memory

Memory 适合保存跨会话仍然成立的事实。自动召回最多加载少量相关条目，并且只进入当前请求，不进入 Session 历史，避免每轮重复膨胀。

这三种机制的边界应当保持清楚：

| 机制 | 保存什么 | 生命周期 |
|---|---|---|
| KB | 项目维护的稳定参考文档 | 随 Git 版本控制 |
| Skill | 可复用工作流程 | 随 Skill 文件维护 |
| Memory | 项目事实和用户偏好 | 跨 Session 持久化 |
| Session | 当前完整对话过程 | 当前工作区运行状态 |

## 9. 多 Provider 和模型切换

不要把 Provider 逻辑写死在 Agent Loop 中。

内部统一使用 `ModelProvider`，具体接入由 `OpenAICompatibleProvider` 或未来的专用适配器负责。

这样可以让：

- Agnes 成为默认 Provider；
- MiniMax 通过配置和 REPL 切换；
- 不同 Provider 拥有独立模型目录；
- Agent Loop 不关心具体 HTTP 协议。

模型目录缓存和模型选择状态也要分开：

- `.andi-agent/models.json` 保存模型目录；
- `.andi-agent/selection.json` 保存最近选择；
- `/models` 优先读取本地目录；
- `/models refresh` 才主动访问 Provider。

模型切换时必须在动态上下文中明确当前模型身份，但不要频繁改变稳定 system prompt，否则会降低 Prompt 缓存命中率。

## 10. Scheduler：从交互 Agent 到后台 Agent

定时任务不是简单地加一个 `setInterval`。

一个安全的 Scheduler 需要：

- 持久化任务注册表；
- 一次性和固定间隔两种计划；
- 严格的时间和任务 ID 校验；
- 任务运行前先推进下次时间；
- 全局串行，避免多个 Agent 同时修改同一工作区；
- 后台运行不等待交互审批；
- 任务独立 Session；
- 运行日志和失败状态；
- Ctrl-C 取消当前任务。

当前采用 at-most-once 策略：任务启动前先记录运行状态和下一次时间，避免进程崩溃后重复执行可能有副作用的 Coding Task。

后台 Agent 的工具集也应该更保守：记忆只读，危险命令没有审批器时拒绝，Git 写操作不自动运行。

## 11. Prompt 缓存和上下文成本

当 Agent 每轮都重复发送大量 system prompt、工具定义和项目规则时，成本和延迟都会增加。

当前优化方向是：

- 工具定义按名称稳定排序；
- System Prompt 保持稳定；
- 当前模型身份放在动态请求尾部；
- Memory、Skill 正文、当前任务和工具结果放在动态区域；
- 解析 Provider 返回的 `cached_tokens` 等 usage 字段；
- 在 `/usage` 和运行日志中显示缓存命中 Token。

缓存是否真正生效由 Provider 决定。OpenAI-compatible 并不意味着所有服务商支持相同的缓存协议，因此 Agent 只能报告 Provider 返回的事实，不能自行假设命中。

核心原则：

```text
稳定内容放前面，动态内容放后面。
```

## 12. 测试策略：测试边界，不只测试快乐路径

一个能干活的 Agent，测试重点不是“模型返回了 Hello”，而是边界是否可靠。

### 12.1 Agent 测试

- 模型调用 → 工具执行 → 最终回答闭环；
- 未知工具；
- 无效 JSON 参数；
- 最大轮数；
- 工具失败后继续；
- 取消传播；
- 上下文压缩；
- Memory 临时注入不进入 Session；
- 模型身份切换；
- checkpoint 顺序。

### 12.2 工具测试

- 路径穿越；
- 符号链接；
- 保留目录；
- 多匹配编辑；
- 命令审批；
- Shell 注入；
- 输出截断；
- 超时和取消；
- Git pathspec；
- 敏感信息写入 Memory。

### 12.3 终端测试

- 中文和 Emoji 宽度；
- 多行输入；
- TUI 光标位置；
- Markdown 表格和引用；
- 流式与非流式输出切换；
- Ctrl-C/Ctrl-D；
- 模型选择器和命令补全。

### 12.4 真实 API 测试

自动化测试不应依赖 API Key。真实 API 测试单独运行，并且必须：

- 使用环境变量，不把 Key 写入代码；
- 只读工作区；
- 不提交、不 push；
- 清晰标记为 live test；
- 对错误、限流和网络取消有预期。

当前验证命令：

```bash
bun test
bun run typecheck
git diff --check
```

## 13. 仓库结构和运行方式

核心源码结构：

```text
src/
├── agent.ts       # Prompt、Loop、事件和 checkpoint
├── cli.ts         # 参数解析和依赖装配
├── repl.ts        # 持久交互循环
├── session.ts     # Session v2 和恢复
├── model/         # Provider 抽象和模型目录
├── tools/         # 工具实现和安全策略
├── memory/        # 长期记忆和检索
├── skills/        # SKILL.md 发现和加载
├── scheduler/     # 定时任务
├── runtime/       # 取消、日志和环境
└── tui/           # 终端 UI
```

常用入口：

```bash
bun install
cp .env.example .env
bun run start -- --repl --session dev
bun run start -- --plain "分析项目结构"
bun test
bun run typecheck
```

临时脚本只能放在：

```text
workspace/temp/
```

不能把临时脚本写到仓库根目录、`src/` 或其他项目目录。

## 14. 哪些决定最重要

### 14.1 先接口，后实现

`ModelProvider`、`ToolRegistry`、`ReplIO` 和 `MemoryProvider` 让核心逻辑可以注入 fake 实现。没有这些接口，测试会被网络、终端和真实文件系统绑架。

### 14.2 把安全策略放在代码里

Prompt 可以提醒模型不要越界，但不能成为唯一防线。路径检查、命令策略、审批、输出限制和敏感信息检测必须由宿主程序执行。

### 14.3 所有持久化都要考虑中断

Session、Scheduler、模型目录和 Memory 都使用原子写入或写入队列。磁盘文件不是“最后再补”的功能，而是运行时系统的一部分。

### 14.4 观察结果比漂亮 UI 更重要

用户需要知道：

- Agent 当前在哪一轮；
- 调用了什么工具；
- 工具成功还是失败；
- 花了多少时间；
- 是否被取消；
- Session 是否完成保存。

UI 可以变化，但事件模型应该稳定。

### 14.5 不要把“能调用 API”误认为“能完成任务”

产品能力来自完整工作流：

```text
读取 → 计划 → 修改 → 验证 → 观察失败 → 修复 → 汇报
```

缺少其中任何一个环节，Agent 都更像聊天机器人，而不是 Coding Agent。

## 15. 下一步路线

当前产品已经覆盖一个本地 Coding Agent 的主要闭环，后续可以继续增强：

1. Provider-specific Prompt Cache 控制和 TTL；
2. 更准确的 tokenizer 预算；
3. 模型驱动的上下文摘要；
4. AST/LSP 代码导航和诊断；
5. MCP 工具和更细粒度权限；
6. 任务级评测集和回放测试；
7. CI、覆盖率、lint 和发布流程；
8. 多 Agent 协作，但要先解决共享工作区冲突；
9. Web 或 IDE 前端，但继续复用 Agent 事件接口；
10. 费用、延迟、缓存命中和任务成功率的长期评估。

## 16. 自我检查清单

完成自己的 Coding Agent 后，可以用下面的问题验收：

- [ ] 我能解释 Prompt、Tool、Loop、Skill、Memory 各自的边界。
- [ ] Agent 修改前会读取代码，修改后会运行验证。
- [ ] 文件工具无法越过 workspace。
- [ ] 危险命令不会绕过审批。
- [ ] Agent 有最大轮数和取消链路。
- [ ] 工具错误能回到模型，取消错误能终止当前轮次。
- [ ] Session 能在进程崩溃后恢复。
- [ ] 不完整的 tool call 不会伪装成成功。
- [ ] Skill 和 KB 会按需加载，而不是整库注入。
- [ ] Memory 不保存密钥、原始对话和临时状态。
- [ ] 后台任务不会等待交互输入。
- [ ] 每个关键安全边界都有自动化测试。
- [ ] 我能从事件或日志还原 Agent 做过什么。
- [ ] 我没有把“模型说它做过”当成“工具证明它做过”。

## 结语

构建高度定制的 Coding Agent，最有价值的不是复制某个产品的界面，而是把自己的工程判断编码成一个可测试的运行时：

- 让模型负责推理；
- 让工具负责行动；
- 让策略负责边界；
- 让事件负责观察；
- 让 Session、Memory 和 KB 负责不同时间尺度的上下文；
- 让测试证明 Agent 做过，而不是让 Agent 自己声称做过。

当这些部分组合起来，Agent 才会从“有想法的 Prompt”变成“可以在真实仓库里交付工作的产品”。
