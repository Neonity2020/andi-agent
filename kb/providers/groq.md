---
title: Groq
category: providers
proto: openai-compatible
endpoint: https://api.groq.com/openai/v1
auth: GROQ_API_KEY
models: llama-3.3-70b-versatile, llama-3.1-8b-instant
updated: 2026-08-19
---

# Groq

OpenAI 兼容接口，主打极低延迟推理。

## 接入

```text
AGENT_BASE_URL=https://api.groq.com/openai/v1
AGENT_MODEL=llama-3.3-70b-versatile
AGENT_API_KEY=$GROQ_API_KEY
```

## 注意

- 提供多种开源模型，标识以官方当前列表为准。
- 上下文和速率限制因模型而异。
