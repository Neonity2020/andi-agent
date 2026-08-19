# Luna 接手上下文

## 当前状态

- 仓库：`/Users/andi/Documents/ChatGPT/andi-agent`
- 分支：`codex/minimax-provider-fixes`
- 本轮已包含 MiniMax、多 Provider/模型切换、动态模型身份、MiniMax think 折叠、天气工具、SKILL 机制和 TUI Markdown 表格渲染。
- 本次 handoff 更新准备随当前功能一起提交并推送。
- 最近完整验证：`bun test` 235 pass / 0 fail；`bun run typecheck` 与 `git diff --check` 通过。

## 已完成但未提交的功能

### 默认持久 Session

- 直接运行 `andi` 默认使用 `default` session，不再显示 `memory-only`。
- 数据保存在当前工作区 `.andi-agent/sessions/default.json`。
- `andi --session <id>` 仍可选择独立 session；单次非 REPL 命令不会自动创建默认 session。
- 入口逻辑在 `src/cli.ts` 的 `resolveSessionId()`。

### 模型列表与切换

- `OpenAICompatibleProvider` 支持 `currentModel`、`listModels()`、`loadModelCatalog()` 和 `selectModel()`。
- Agnes 模型目录通过 `GET /v1/models` 获取；会过滤 image、video、embedding、audio、tts、whisper、moderation 等非聊天模型。
- 已真实只读验证 Agnes 返回文本模型：`agnes-2.0-flash`、`agnes-2.5-flash`、`agnes-2.5-pro-alpha`、`agnes-2.5-pro`。

### 最后使用模型持久化

- `ModelSelectionStore`（`src/model/selection-store.ts`）把最近一次切换的 `(provider, model)` 原子写入当前工作区 `.andi-agent/selection.json`（v1、严格校验、不含凭据）。
- REPL 的所有切换路径（`/models` 选择、`/provider` 切换）通过 `createPersistingModelManager()` 包装 Router，切换成功即落盘，写失败不影响本次进程内切换。
- 启动时 `applyPersistedModelSelection()` 恢复上次选择：先经 CatalogManager 读目录（磁盘缓存命中零联网），再校验模型仍可选；模型过期或目录不可用时安全回退默认。
- 持久化选择优先于 `.env` 默认值：它代表最近一次交互式切换。曾实现 "AGENT_PROVIDER/AGENT_MODEL/MINIMAX_MODEL 显式设置优先"，但 Bun 自动加载 `.env` 且 `.env.example` 预置这些键，导致所有照抄示例配置的用户模型恢复被永久跳过（症状：Provider 恢复、模型停在构造默认如 M2.7），该优先级已移除；删除 `.andi-agent/selection.json` 即回到 `.env` 默认。
- 恢复成功后 TUI 状态栏会立即刷新为恢复后的模型。

### OpenCode 风格 `/models` 选择器

- 默认 TUI 使用下拉选择器，不再把模型列表打印到对话滚屏。
- 支持输入过滤、上下循环、Page Up/Page Down、Home/End、Enter 确认、Esc/Ctrl-C 取消。
- 当前模型带 `✓`，切换后状态栏立即更新。
- plain REPL 降级为编号或完整 ID 输入。
- 参考源码克隆在 `/tmp/opencode-reference`；主要参考 `packages/tui/src/component/dialog-model.tsx` 和 `packages/tui/src/ui/dialog-select.tsx`。
- 曾修复 picker 方法丢失 `this` 的真实 Bug；`runRepl` 必须使用 `picker.call(options.io, ...)`，已有回归测试。
- TUI 光标定位曾因"帧未变化即跳过重绘"短路而失效：左右方向键只移动光标、不改输入文本，被当作无变化直接 return，可见光标不动。现在 `#paint()` 在短路判断里纳入光标目标列，纯光标移动也会重新定位。

### 持久化多 Provider 模型目录

- 缓存文件：当前工作区 `.andi-agent/models.json`。
- 普通 `/models`：内存缓存 → 磁盘缓存 → 首次 cache miss 才请求 Provider。
- `/models refresh`：强制刷新当前 Provider。
- v1 JSON 从一开始支持多个 Provider，包含 `id`、无凭据的 `source`、`updatedAt` 和模型数组。
- `ModelCatalogStore` 负责严格校验、同进程串行更新、临时文件加 `rename()` 原子写入。
- `ModelCatalogManager` 负责 memory/disk/provider 三层读取及选择转发。
- 缓存损坏、版本未知或 source 不匹配视为 miss；文件不保存 API Key。
- 跨 Manager 实例磁盘命中已测试为零次 Provider 请求。

### 全局退出键

- `Ctrl-D` 在输入、模型选择、审批和运行状态下直接退出。
- 若 Agent 正在运行，会先 abort 当前请求并恢复终端。
- `Ctrl-C` 语义不变：运行时取消当前轮，空闲时退出。
- 第一次 Ctrl-D 已能退出 REPL，但 stdin 未暂停会让进程继续等待输入；`Tui.close()` 和 plain `TerminalChannel.close()` 现在会暂停 stdin，按一次即可结束 `andi`。

### MiniMax 国内版与运行时 Provider 切换

- MiniMax 国内 OpenAI-compatible 端点：`https://api.minimaxi.com/v1`。
- 官方模型目录：`GET /models`；对话接口：`POST /chat/completions`。
- Agnes 仍是默认 Provider，已有 `AGENT_MODEL`、`AGENT_BASE_URL` 和 `AGNES_API_KEY` 配置不会被 MiniMax 覆盖。
- MiniMax 使用独立变量：`MINIMAX_API_KEY`、可选 `MINIMAX_MODEL`、`MINIMAX_BASE_URL`。
- 配置 `MINIMAX_API_KEY` 后会额外注册 MiniMax；两套凭据、模型和 endpoint 独立保存。
- REPL 使用 `/provider` 查看 Provider，`/provider minimax` 切换到 MiniMax，`/provider agnes` 切回 Agnes；切换后 `/models` 和 `/models refresh` 针对当前 Provider 工作。
- `/models` 现在聚合所有已配置 Provider，显示 `agnes/<model>`、`minimax/<model>`；选择条目会自动切换 Provider 和模型。若只想查看当前 Provider，仍可使用 `/provider` 后再操作。
- `ModelProviderRouter` 负责运行时路由，后续请求使用当前 Provider；模型目录按 Provider ID 和 source 隔离缓存。
- 不再根据 `MINIMAX_API_KEY` 覆盖 Agnes 的 `AGENT_BASE_URL`；此前导致 MiniMax 请求误发到 Agnes 并返回 401 的逻辑已修复。

### 当前模型身份注入

- `ModelProvider` 可提供实时 `getModelIdentity()`；`OpenAICompatibleProvider` 和 `ModelProviderRouter` 均已实现。
- Agent 每轮请求前把当前 `Provider`/`Model` 作为权威 system context 注入，因此用户询问“你在使用哪款模型”时，答案跟随运行时切换，而不是沿用启动时配置。
- 已移除 CLI/定时任务注入的旧静态 `modelName` 文本；此前它可能与运行时已切换的模型冲突（例如实际 M2.7 却残留 M2.2）。
- 曾有关键词命中即本地返回身份的短路逻辑，因会劫持仅提及模型关键词的普通任务（如"这个数据模型里哪个字段正在使用"）已移除；身份询问现在一律走模型，由 system prompt 中的权威身份上下文作答。
- 身份块声明对话历史中关于其他模型/Provider 的说法是切换前的过期快照，必须忽略；当历史 system prompt 中的身份与当前运行时身份不同（发生过 `/models` 或 `/provider` 切换）时，额外注入一条 "runtime model was switched" 说明，直接对冲历史里旧 assistant 声明，避免模型跟着历史自称旧模型。
- 该身份不会写入 API Key、endpoint 或敏感凭据；只暴露 Provider ID 与模型 ID。

### MiniMax `<think>` 输出

- MiniMax 返回的 `<think>...</think>` 内容由 `src/tui/activity.ts` 的 `parseThinkTags()` 增量处理。
- TUI 流式预览和最终输出都会隐藏标签正文，只显示默认折叠的 `thinking (collapsed) · N chars` 摘要；普通答案正常渲染。
- 未闭合的 `<think>` 也会被视为仍在思考，不会把内部内容直接显示到 TUI。

### Weather 工具

- `src/tools/weather.ts` 已纳入工具注册表，使用 Open-Meteo 地理编码和预报接口查询城市天气，不需要 API Key。
- 工具返回当前温度、体感、天气状况、湿度、风速及未来三天预报；城市输入限制为 1–200 个字符。
- 通过可注入的 fetcher 测试 API 请求、时区传递、输入校验和取消行为。

### Skills 机制

- `SkillManager` 实现 Agent Skills `SKILL.md` 的发现、YAML frontmatter 解析、元数据预加载、按任务自动匹配和显式 `/skill-name` 调用。
- 兼容项目/用户级 `.agents/skills`、`.claude/skills`，并兼容旧 `.codex/skills`；同名技能按项目优先，避免用户配置覆盖仓库约定。
- 支持 Claude 常用字段与模板：`$ARGUMENTS`、`${CLAUDE_SKILL_DIR}`、`disable-model-invocation`、`user-invocable`、`context`、`allowed-tools` 和 ``!`command` `` 动态上下文。
- 动态上下文命令只在显式 `/skill-name` 调用时经现有命令审批边界执行；自动匹配的技能不执行任何命令，只注入跳过说明。无审批器时拒绝执行，不允许技能绕过 `run_command` 的安全策略。
- 正文里位于代码围栏或 `` ``…`` `` 行内代码中的 ``!`command` `` 是文档示例，不会被当作真实命令执行。
- 技能评分对 ASCII 词元使用整词匹配，避免 "hi" 之类短词作为子串命中 "searching"/"third-party" 导致问候语误加载技能。
- Agent system prompt 只预加载技能名称/描述，正文按需加载；REPL 增加 `/skills` 和 `/skill-name [args]`。

### TUI Markdown 解析与 Grid 表格渲染

- 升级为行业标准 `marked.Lexer` AST 解析驱动，彻底废除脆弱的手写正则状态机与逐行扫描逻辑，对代码块、引用、列表、标题及表格实现结构化 Token 解析。
- Markdown 表格采用 OpenCode 同款标准 Grid 风格网格边框（`┌┬┐`、`├┼┤`、`└┴┘`、`│`、`─`），并结合主题暗色 `theme.style.dim` 增强可读性。
- 表格列按终端 cell 宽度自适应分配（`Bun.stringWidth` / `Intl.Segmenter`），准确处理 CJK 双宽字符与 Emoji 宽度计算，支持左/中/右对齐、转义管道符及超宽单元格自动软折行。
- 表格渲染覆盖最终 TUI 回复输出，不改变流式文本、代码块和普通 Markdown 行为。
- 配合 `DEFAULT_SYSTEM_PROMPT` 紧凑表格输出引导，保证在 60/80 列及更宽终端下均能紧凑居中对齐、排版严整。

## 关键文件

- `.plans/011-model-switching.md`：模型切换与 TUI picker 方案。
- `.plans/012-persistent-model-catalog.md`：持久模型目录方案与验证结果。
- `src/model/openai-compatible.ts`：Provider 网络目录、过滤、超时、取消和脱敏。
- `src/model/catalog-store.ts`：`.andi-agent/models.json` 存储。
- `src/model/catalog-manager.ts`：缓存策略。
- `src/model/selection-store.ts`：最后使用模型持久化、启动恢复与 REPL 切换包装。
- `src/model/providers.ts`：Provider 默认配置、工厂和运行时路由器。
- `src/agent.ts`：每轮动态注入当前模型身份。
- `src/repl.ts`：`/models`、`/models refresh`、picker 接口、全局退出。
- `src/tui/tui.ts`：交互选择器和全局按键处理。
- `src/tui/input.ts`：Esc 延迟解析。
- `src/tui/activity.ts`：流式状态与 MiniMax think 标签解析/折叠摘要。
- `src/tui/markdown.ts`：终端宽度感知的轻量 Markdown 渲染，包含表格边框、对齐和单元格换行。
- `test/markdown.test.ts`：Markdown 表格、宽字符和长单元格回归测试。
- `src/tools/weather.ts`：Open-Meteo 天气查询工具。
- `test/weather.test.ts`：天气工具请求、格式化、校验和取消回归测试。
- `src/skills/manager.ts`：跨 Claude Code/Codex 的 SKILL.md 发现、解析和注入。
- `test/skills.test.ts`：技能发现、优先级、自动匹配、显式调用和动态上下文测试。
- `.agents/skills/skill-creator/SKILL.md`：用于创建和维护可跨 Claude Code/Codex 复用的项目 Skill。
- `test/model-catalog.test.ts`：目录 Store/Manager 测试。
- `test/model-selection.test.ts`：选择持久化、恢复优先级与回退测试。
- `test/config.test.ts`、`test/repl.test.ts`、`test/tui.test.ts`、`test/agent.test.ts`：Provider 配置/切换、Ctrl-D 与当前模型身份回归测试。

## 工作区注意事项

- 本轮功能改动应整体保留；提交时只纳入明确属于功能的文件。
- `.zcode/`、`non-ai/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 是无关未跟踪内容，不要加入提交或删除。
- `.andi-agent/` 是敏感运行状态并已忽略；`.memory/` 是长期记忆 Markdown 目录。
- `docs/` 用于测试 Agent 生成能力。
- 遵循 `AGENTS.md`：TypeScript ESM、两空格、分号、双引号、严格类型；编辑后运行：

```bash
bun test
bun run typecheck
git diff --check
```

若非登录 shell 找不到 Bun，可使用 `/Users/andi/.bun/bin/bun`。

## 建议接手动作

1. 先阅读本文件及 `.plans/011-model-switching.md`、`.plans/012-persistent-model-catalog.md`。
2. 执行 `git status --short`，确认无关未跟踪文件仍未被纳入。
3. Provider Registry/运行时路由已落地；后续增加 Provider 时复用 `AgentProvider`、`ProviderConfig`、`ModelProviderRouter` 和 `ModelCatalogManager`，不要把 Provider 分支堆回 CLI 或 `OpenAICompatibleProvider`。
4. 若当前阶段只需收尾，做一次真实交互冒烟：Agnes 默认启动、配置 MiniMax 后 `/provider minimax`、`/models refresh`、下一轮使用 MiniMax、`/provider agnes` 切回、Ctrl-D 一次退出。
5. 已完成本轮提交并推送后，后续改动继续保持显式文件 staging，避免纳入工作区中的无关用户文件。
