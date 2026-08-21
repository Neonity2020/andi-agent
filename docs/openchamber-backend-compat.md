# 使用 OpenChamber UI 连接 andi-agent

`andi-agent` 现在提供一组 OpenCode-compatible 的基础 API，可以让官方 OpenChamber Web UI 作为前端运行，Agent、Session、工具和模型仍由 andi-agent 负责。

OpenChamber UI 源码已集成在本仓库的 `src/web`，上游仓库为：

https://github.com/openchamber/openchamber
```

## 架构

```text
OpenChamber packages/web + packages/ui
                │
                │ OpenCode REST + global/event SSE
                ▼
andi-agent --web
                │
                ├── Agent Loop
                ├── SessionStore
                ├── ToolRegistry
                ├── ModelProvider
                └── Command Approval
```

OpenChamber UI 不是直接调用 andi 的 `/api/runs`，而是使用 OpenCode 风格接口：

- `GET /api/path`
- `GET /api/project`
- `GET /api/project/current`
- `GET /api/config`
- `GET /api/config/providers`
- `GET /api/session`
- `POST /api/session`
- `GET /api/session/:id`
- `GET /api/session/:id/message`
- `POST /api/session/:id/prompt_async`
- `POST /api/session/:id/abort`
- `GET /api/session/status`
- `GET /api/global/event`（SSE）

## 启动

首次准备前端依赖并构建：

```bash
bun run web:install
bun run web:build
```

启动 andi 后端：

```bash
andi --web --port 4317
```

`andi --web` 会优先提供 `src/web/packages/web/dist` 中的构建结果；更新 UI 源码后重新执行 `bun run web:build`。

打开：

```text
http://127.0.0.1:5173
```

OpenChamber 的 `packages/web/vite.config.ts` 会把 `/api` 请求代理到 `OPENCHAMBER_PORT`。当前 andi 后端只绑定 `127.0.0.1`，不会开放到局域网。

## 事件映射

andi 的 Agent 事件会映射为 OpenCode 全局事件：

| andi 事件 | OpenCode 事件 |
|---|---|
| `model_text_delta` | `message.part.delta` |
| `tool_started` | `message.part.updated`，工具状态为 running |
| `tool_completed` | `message.part.updated`，工具状态为 completed/error |
| 运行开始 | `session.status` busy |
| 运行完成 | `message.updated`、`session.status` idle、`session.idle` |
| 命令审批 | `permission.asked` |

## 当前兼容范围

已覆盖：

- 会话列表、创建、读取、重命名和删除；
- 会话消息历史；
- Prompt 异步提交；
- 流式文本增量；
- 工具状态；
- 会话 busy/idle 状态；
- 命令审批事件；
- Provider、项目和工作区基础 bootstrap 接口。

暂未覆盖：

- OpenChamber Git/GitHub 面板；
- Web Terminal；
- Worktree 管理；
- MCP/LSP 实时状态；
- Desktop Relay、移动端配对和通知；
- OpenChamber 专属的 Session Goals、Multi-run 和 Fusion。

这些能力可以在核心聊天链路稳定后逐项实现，不应混入 Agent Loop。
