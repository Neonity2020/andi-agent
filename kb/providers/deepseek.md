---
title: DeepSeek
category: providers
proto: openai-compatible
endpoint: https://api.deepseek.com
auth: DEEPSEEK_API_KEY
models: deepseek-chat, deepseek-reasoner
updated: 2026-08-19
---

# DeepSeek

OpenAI 兼容接口，`/chat/completions` 可直接使用。

## 接入

```text
AGENT_BASE_URL=https://api.deepseek.com
AGENT_MODEL=deepseek-chat
AGENT_API_KEY=$DEEPSEEK_API_KEY
```

## 注意

- 模型名：`deepseek-chat`（通用对话）、`deepseek-reasoner`（推理）。
- 支持 function calling；`deepseek-reasoner` 的思维链内容以 `reasoning_content` 返回，非标准字段。
- 兼容模式鉴权用 `Authorization: Bearer`，与 OpenAI 相同。
