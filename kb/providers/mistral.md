---
title: Mistral
category: providers
proto: openai-compatible
endpoint: https://api.mistral.ai/v1
auth: MISTRAL_API_KEY
models: mistral-large-latest, mistral-small-latest, open-mistral-nemo
updated: 2026-08-19
---

# Mistral

OpenAI 兼容接口。

## 接入

```text
AGENT_BASE_URL=https://api.mistral.ai/v1
AGENT_MODEL=mistral-large-latest
AGENT_API_KEY=$MISTRAL_API_KEY
```

## 注意

- function calling 支持良好，原生就是 OpenAI 风格。
- 模型名带 `-latest` 后缀会跟随厂商滚动更新。
