---
title: OpenAI
category: providers
proto: openai-compatible
endpoint: https://api.openai.com/v1
auth: OPENAI_API_KEY
models: gpt-4o, gpt-4o-mini, gpt-4.1, o3, o4-mini
updated: 2026-08-19
---

# OpenAI

原生即 OpenAI 协议，`chat/completions` 完全兼容本项目适配层。

## 接入

```text
AGENT_BASE_URL=https://api.openai.com/v1
AGENT_MODEL=gpt-4o
AGENT_API_KEY=$OPENAI_API_KEY
```

## 注意

- 支持 function calling、流式与 `stream_options.include_usage`。
- `o` 系列推理模型对工具调用/系统提示有额外约束，接入前核对官方限制。
- 模型标识随官方更新而变化，以当下官方模型页为准。
