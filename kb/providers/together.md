---
title: Together AI
id: together
category: providers
type: provider
status: reference
proto: openai-compatible
endpoint: https://api.together.xyz/v1
auth: TOGETHER_API_KEY
models: meta-llama/Llama-3.3-70B-Instruct-Turbo, Qwen/Qwen2.5-72B-Instruct-Turbo
updated: 2026-08-19
source: https://docs.together.ai/
related: ["../MOC.md"]
---

# Together AI

OpenAI 兼容接口，托管大量开源模型。

## 接入

```text
AGENT_BASE_URL=https://api.together.xyz/v1
AGENT_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
AGENT_API_KEY=$TOGETHER_API_KEY
```

## 注意

- 模型名需用完整 `org/model` 标识。
- 支持 function calling（各模型支持度不一，需按模型核实）。
