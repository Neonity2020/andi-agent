# 第十一阶段：运行时模型列表与切换

## 状态

已完成。Provider、REPL、TUI 与文档均已接入，完整测试、类型检查和差异检查通过。

## 目标

在常驻 REPL 中提供 `/models` 命令：每次调用都从当前 OpenAI-compatible 服务的 `GET /models` 拉取最新模型列表，显示适合 Chat Completions 的模型，让用户用编号或完整模型 ID 选择，并让后续 Agent 请求立即使用新模型。

## 已验证协议

- Agnes Base URL：`https://apihub.agnes-ai.com/v1`。
- 模型列表：`GET /v1/models`，使用 `Authorization: Bearer <key>`。
- 响应采用 OpenAI list 格式：`{ data: [{ id: string, ... }] }`。
- 2026-08-19 实际探测返回 7 个 ID；coding agent 应过滤 image/video 模型，只展示 4 个文本模型。

## 运行语义

- `/models` 拉取列表后，在默认 TUI 中打开交互式模型选择器。
- 选择器接受即时输入过滤，支持方向键、Page Up/Page Down、Home/End、Enter 和 Esc；当前模型带标记并作为初始选中项。
- classic plain REPL 降级为从 1 开始的编号或完整模型 ID；空输入取消，非法选择不改变当前模型。
- 切换成功后 TUI 状态栏同步更新。
- 切换只影响当前进程中后续的模型请求，不修改 `.env`，不改变已保存的 session，也不影响独立 scheduled runner。
- 重启后仍以 `AGENT_MODEL` 为初始模型；持久化默认模型属于后续独立功能。

## 实现方案

### Provider

扩展 `OpenAICompatibleProvider`：

- `currentModel` getter。
- `listModels(signal?)`：请求 `/models`，严格校验响应、去重并限制数量/ID 长度。
- `selectModel(id)`：只接受本次列表中存在且适合 Chat Completions 的 ID。
- 15 秒超时、取消传播、API Key 脱敏和有限错误正文。

新增 `ModelCatalogEntry` 与 `SwitchableModelProvider` 类型。过滤明显非聊天模型：image、video、embedding、audio、tts、whisper、moderation 等；当前 Agnes 的 image/video ID 不进入选择列表。

### REPL 与 TUI

在 `ReplOptions` 注入小型 `ReplModelManager` 接口，避免 REPL 依赖具体 provider。

`/models` 流程：

1. 拉取并校验可选模型列表。
2. 若 `ReplIO` 提供 `select()`，打开 TUI 下拉菜单；搜索、导航、确认或取消均在 managed region 内完成。
3. 若没有 `select()`，以 `1. model-id` 形式显示并调用 `io.read("model> ")`，保留 plain REPL 兼容性。
4. 校验并切换，随后更新状态栏。

交互参考 OpenCode 的 `DialogModel` 与通用 `DialogSelect`：当前项预定位/标记、即时搜索、循环方向键导航、翻页、首尾跳转、Enter 确认和 Esc 关闭。实现保持本项目现有的零 UI 框架依赖。

`/status` 增加当前模型。TUI 新增 `setModel()`，成功切换后立即重绘状态栏。plain REPL 使用相同逻辑。

## 测试

- Provider：请求 URL/鉴权、响应校验、去重/过滤、切换后下一次 completion body、HTTP/网络/超时/取消、Key 脱敏。
- REPL：TUI picker 路径、plain 编号/ID 路径、取消、非法输入、列表失败、后续任务使用已切换 manager。
- TUI：搜索、键盘选择、Esc 取消以及 `setModel()` 后状态栏重绘。
- CLI：provider manager 正确传入 TUI/plain REPL。

最终验证：

```bash
bun test
bun run typecheck
git diff --check
```

再执行一次真实只读 `/models` 冒烟，确认 Agnes 返回列表且密钥不出现在输出中；不发送 Chat Completions 请求。

## 完成标准

- `/models` 能稳定列出当前服务的聊天模型并交互选择。
- 切换后的下一轮请求体使用新模型。
- 图像/视频等不兼容模型不可选择。
- 列表失败或选择非法时保留原模型。
- TUI 和 plain REPL 行为一致，状态栏/状态命令反映当前模型。

## 验证结果

- Agnes `GET /v1/models` 真实只读探测成功，返回的文本模型可用。
- `bun test`：195 pass，0 fail。
- `bun run typecheck`：通过。
- `git diff --check`：通过。
