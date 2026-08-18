---
title: Moonshot (Kimi)
category: providers
proto: openai-compatible
endpoint: https://api.moonshot.cn/v1
auth: MOONSHOT_API_KEY
models: moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k, kimi-k2
updated: 2026-08-19
---

# Moonshot (Kimi)

OpenAI 兼容接口。

## 接入

```text
AGENT_BASE_URL=https://api.moonshot.cn/v1
AGENT_MODEL=moonshot-v1-128k
AGENT_API_KEY=$MOONSHOT_API_KEY
```

## 注意

- 长上下文（128k）适合大型代码库分析。
- function calling 支持；部分模型对 `system` 消息有映射到 `developer` 的差异，兼容模式下通常可用。
