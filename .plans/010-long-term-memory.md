# 第十阶段：可靠的长期记忆管理机制

## 状态

已实现并完成验证。

## 目标

把当前仅靠系统提示使用 `.memory/` 的方式，升级为可预测、可审计、可测试的长期记忆系统：Agent 在每轮任务前自动召回相关记忆，也能通过专用工具显式新增、更新和归档记忆，同时避免把整库塞入上下文或让无人值守任务污染记忆。

## 已确认约定

- `.memory/` 是当前 workspace 的长期记忆目录；`.andi-agent/` 继续只保存 session、运行日志和调度状态。
- 记忆使用 Markdown，允许 YAML front matter；`.memory/README.md` 是人工可读的说明和索引。
- 第一版使用本地确定性词法检索，不引入向量数据库、embedding API 或新运行时依赖。
- 自动召回只注入当前 run 的临时模型上下文，不进入 session 检查点，避免跨轮重复和上下文膨胀。
- 普通交互 Agent 可读写；scheduled Agent 自动召回并只读，禁止后台任务新增、修改或删除记忆。
- 不做隐藏的“第二次模型总结请求”。所有写入都通过可见的工具调用发生，便于用户审计。

## 一、存储模型与安全边界

新增 `src/memory/types.ts` 和 `src/memory/store.ts`。

每个主题一个 Markdown 文件，建议 front matter：

```markdown
---
title: Preferred research sources
tags: [research, sources, ai-news]
updated: 2026-08-19
---

正文只记录稳定、可复用的信息。
```

`MemoryStore` 提供 `list`、`read`、`search`、`remember`、`archive` 和 `buildContext`。约束如下：

- 只接受 `.md`；文件名使用安全 slug，拒绝绝对路径、`..`、嵌套逃逸和符号链接。
- `README.md` 保留，不允许工具删除或覆盖。
- 单文件、文件数、总字节数、工具输出和注入上下文均设硬上限。
- 写入使用临时文件加 `rename`，同一 store 串行化写操作。
- `archive` 移入 `.memory/archive/`，不做不可恢复删除。
- 写入前扫描常见密钥、Bearer token、私钥头和 `.env` 赋值；命中即拒绝。
- Markdown 内容视为参考数据，不得覆盖 system prompt、安全策略或用户当前指令。

重构 workspace 路径校验：普通 `read_file`、`write_file`、`edit_file` 和 `list_files` 不直接操作 `.memory/`；只能走专用记忆接口。Git 工具仍可在用户审批后显式 stage 记忆文件。`search_code` 明确排除 `.memory/**`。

## 二、确定性召回

新增 `src/memory/retrieval.ts`：

- 用 `Intl.Segmenter` 做中英文分词，缺失时回退到 ASCII token 与 CJK 字符/双字组合。
- 标题和 tags 权重大于正文；完整短语匹配加权；正文命中按长度归一化。
- 不只按“最新”排序，避免新文件长期压制更相关内容。
- 无有效匹配时返回空，不为了填满配额注入无关记忆。
- 默认最多 3 篇，并受总字符预算控制；结果包含命中文件、分数和截断状态。

在 `Agent` 中加入只读 `MemoryProvider` 接缝。`runWithHistory` 在接收用户 task 后、第一次模型调用前检索记忆。模型请求临时组装为：基础 system → 受边界标记的 memory context → 持久历史 → 当前用户消息。memory context 不加入 `messages`，因此不会被 checkpoint、session 或 context compaction 持久化。

## 三、Agent 记忆工具

新增 `src/tools/memory.ts`，稳定工具名：

- `memory_search`：按查询返回匹配摘要与 ID。
- `memory_read`：读取一篇完整记忆。
- `memory_remember`：创建或精确更新一篇记忆，要求 title、tags、content；返回 created/updated 和文件路径。
- `memory_archive`：可恢复归档；描述中强调只有用户明确要求遗忘或旧事实已确认失效时才调用。

工具不接受任意路径，只接受 store 返回的 ID/slug。普通 CLI 注册四个工具；scheduled runner 只注册 `memory_search` 与 `memory_read`。工具调用继续使用现有取消链路和 `ToolRegistry` 错误封装。

系统提示补充明确触发规则：

- 用户说“继续、上次、按之前约定、记住、以后、我的偏好”时优先查记忆。
- 架构决策、长期约定、稳定环境事实或明确用户偏好可记忆。
- 测试结果、临时任务状态、猜测、网页原文、密钥和完整对话不可记忆。
- 新事实与旧记忆冲突时先向用户说明；不得静默覆盖。

## 四、可观察性与交互

新增 `memory_context_loaded` Agent 事件，仅记录文件 ID、数量、字符数和是否截断，不记录正文。TUI/纯文本模式显示简短状态，例如 `memory · 2 notes`；RunRecorder 可安全记录元数据。

REPL 增加只读命令：

- `/memory` 或 `/memory list`：列出记忆摘要。
- `/memory search <query>`：本地检索，不调用模型。
- `/memory show <id>`：显示单篇内容。

写入与归档仍交给可见的 Agent 工具调用，避免额外维护两套修改协议。

## 五、迁移与文档

- 为现有 `.memory/sources.md` 补 front matter，并保持正文内容。
- 完善 `.memory/README.md`：索引、允许内容、禁止内容、冲突处理和归档规则。
- README 说明自动召回、四个工具、scheduled 只读策略和 Git 可见性。
- AGENTS.md 继续区分 `.memory/` 与 `.andi-agent/`，并说明提交前需检查记忆中是否含敏感信息。
- 从 `src/index.ts` 导出 MemoryStore、类型及工具创建函数。

## 六、测试矩阵

新增：

- `test/memory-store.test.ts`：CRUD、原子写、并发、归档、front matter、容量限制、路径穿越、symlink、密钥拒绝。
- `test/memory-retrieval.test.ts`：中英文召回、标题/tags 权重、无匹配、预算截断、稳定排序。
- `test/memory-tools.test.ts`：schema、参数校验、读写模式、scheduled 只读。
- `test/memory-agent.test.ts`：相关记忆在第一次请求前注入、无关记忆不注入、临时上下文不进入结果和 checkpoint、取消传播。
- 扩展 `test/repl.test.ts`、`test/tui.test.ts`、`test/cli.test.ts`、`test/scheduler-runner.test.ts` 和 recorder 测试。

最终验证：

```bash
bun test
bun run typecheck
git diff --check
```

再做一次真实 REPL 冒烟：先要求 Agent 记住一个稳定偏好，退出并换新 session，提出相关任务，确认自动召回事件出现且回答遵循该偏好。

## 分阶段提交建议

1. `feat: add bounded memory store and retrieval`
2. `feat: inject relevant memory into agent runs`
3. `feat: add long-term memory tools`
4. `feat: expose memory status in repl and tui`
5. `docs: document long-term memory lifecycle`

## 完成标准

- 新 session 无需用户提醒即可召回与当前任务相关的记忆。
- 无关记忆不进入模型请求，召回有固定预算且不会写入 session。
- 所有记忆变更可见、可恢复、受路径/容量/敏感信息保护。
- scheduled Agent 只能读取记忆。
- 中英文、取消、并发、安全边界与跨 session 行为都有自动化测试覆盖。

## 实施结果

- 新增受限 `MemoryStore`、中英文确定性检索、临时上下文注入和四个专用工具。
- 交互 Agent 可读写，scheduled Agent 只读；通用文件工具与代码搜索隔离 `.memory/`。
- 增加乐观并发更新、原子写、可恢复归档、容量/路径/symlink/敏感信息保护。
- 增加 `memory_context_loaded` / `memory_context_failed` 事件、TUI 状态和 `/memory` REPL 命令。
- 现有 `sources.md` 已迁移到带 front matter 的记忆文档。
- 验证结果：176 tests pass、`tsc --noEmit` 通过、`git diff --check` 通过，真实 REPL 读/search 冒烟通过。
