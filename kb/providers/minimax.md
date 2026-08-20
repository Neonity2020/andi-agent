---
title: MiniMax 国内版
id: minimax
category: providers
type: provider
status: reference
proto: openai-compatible
endpoint: https://api.minimaxi.com/v1
auth: MINIMAX_API_KEY
models: MiniMax-M2.7
updated: 2026-08-21
source: https://platform.minimaxi.com/docs/api-reference/text-chat
related: ["../MOC.md", "agnes.md"]
---

# MiniMax 国内版

MiniMax 国内版通过 OpenAI-compatible Chat Completions 接口接入本项目。

## 接入

```text
AGENT_PROVIDER=minimax
MINIMAX_API_KEY=...
MINIMAX_MODEL=MiniMax-M2.7
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
```

也可以在 REPL 中使用 `/provider minimax` 切换。模型目录通过 `/models refresh` 获取，当前选择会保存到工作区的 `.andi-agent/selection.json`。

## 注意

- 本项目只使用兼容层，不代表所有 MiniMax 原生能力都可用。
- 模型、价格、限流和响应字段以 MiniMax 官方文档及实际 API 响应为准。
- 不要把 `MINIMAX_API_KEY` 写入知识库、Session 或长期记忆。
