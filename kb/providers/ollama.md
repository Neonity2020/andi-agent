---
title: Ollama (本地)
category: providers
proto: openai-compatible
endpoint: http://localhost:11434/v1
auth: 无（本地）
models: llama3.2, qwen2.5, mistral 等
updated: 2026-08-19
---

# Ollama (本地)

本地运行的开源模型，提供 OpenAI 兼容端点 `/v1/chat/completions`。

## 接入

```text
AGENT_BASE_URL=http://localhost:11434/v1
AGENT_MODEL=llama3.2
```

## 注意

- **本地无鉴权**，不需要 `AGENT_API_KEY`；但本项目 `OpenAICompatibleProvider` 构造要求非空 apiKey，
  因此需让 apiKey 非空占位（如环境变量设 `AGENT_API_KEY=ollama`）才能通过校验。
- 需先 `ollama pull <model>` 拉取模型。
- 功能调用支持取决于所选模型；部分小模型的 function calling 薄弱。
