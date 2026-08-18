# 第四阶段：模型流、代码搜索与 Git 工作流

## 1. 目标

提升交互速度和真实代码库工作效率，并把 Git 变更审阅与提交纳入受控工具体系。

完成后 Agent 应能：

- 从 Agnes Chat Completions SSE 响应增量显示文本；
- 正确拼装跨多个 SSE chunk 的工具调用名称和 JSON 参数；
- 使用 ripgrep 搜索代码文本并得到受限结果；
- 查看 Git 状态和 diff；
- 经用户逐条批准后暂存指定文件并提交已经暂存的变更。

## 2. Token 流式输出

### 2.1 内部协议

`ModelProvider.complete` 增加可选的 `onTextDelta` 回调。未提供回调时继续使用普通 JSON 响应，保持库调用和现有测试兼容；CLI 默认提供回调，因此真实 Agnes 请求使用 `stream: true`。

### 2.2 SSE 解析

- 增量读取 `response.body`，不能假设一个网络 chunk 等于一条 SSE event；
- 以空行分隔 event，拼接多个 `data:` 行；
- 识别 `[DONE]`；
- 累积 `delta.content`；
- 依据 `tool_calls[].index` 合并分片的 `id`、函数名和 arguments；
- 结束时校验每个工具调用字段完整，再转换为内部 `AssistantTurn`。

新增 `model_text_delta` Agent 事件。CLI 将 token 写入 stdout，状态事件继续写 stderr，最终避免重复打印完整回答。

## 3. `search_code`

- 使用 `rg` 参数数组直接启动进程，不经过 shell；
- 默认固定字符串搜索，可显式启用正则；
- 可选 glob 仅作为 `rg --glob` 的单个参数传入；
- 固定跳过 `.git`、`.andi-agent`、`node_modules`；
- 限制每文件匹配数、总输出字节和最终结果条数；
- `rg` 不存在时返回明确错误。

搜索是只读操作，不触发审批。

## 4. Git 工具

### 4.1 只读工具

- `git_status`：结构化调用 `git status --short`；
- `git_diff`：支持工作区 diff 或 `--cached`，可选指定工作区内路径；
- 强制 `--no-ext-diff`，避免仓库配置启动外部 diff 程序；
- 输出统一限制为 128 KiB。

### 4.2 写操作

- `git_stage`：仅接受明确的路径数组，不提供隐式 `git add .`；
- `git_commit`：只提交已暂存内容，不自动暂存；提交信息必须非空且限制长度；
- 两项操作都复用第三阶段的 `CommandApprover`，终端展示精确 argv；
- 无 TTY、`--approval never` 或用户拒绝时不启动 Git 写进程。

## 5. 实施步骤

1. 扩展模型协议并实现普通 JSON/SSE 双路径。
2. 给 Agent 和 CLI 接入文本 delta 事件及去重输出。
3. 实现受限 ripgrep 搜索工具。
4. 实现 Git 状态、diff、暂存和提交工具。
5. 注册工具、更新系统提示与 README。
6. 为 SSE 分片、工具调用拼装、搜索限制和 Git 审批编写测试。
7. 执行类型检查、完整测试、CLI 检查和差异检查。

## 6. 验收标准

- SSE 文本和分片工具调用能够还原为正确 `AssistantTurn`；
- CLI 流式文本不在结束时重复输出；
- `search_code` 不暴露内部会话或依赖目录；
- Git 只读工具不触发审批；
- Git 暂存/提交未经明确批准不会执行；
- 所有现有非流式调用保持兼容；
- 全部测试和类型检查通过。

## 7. 暂不包含

- Responses API 流式协议；
- token usage/费用统计；
- 自动生成 commit message；
- push、pull、branch 删除或远端 PR 操作；
- AST/LSP 语义搜索。
