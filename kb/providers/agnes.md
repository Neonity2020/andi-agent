---
title: Agnes (本项目默认)
category: providers
proto: openai-compatible
endpoint: https://apihub.agnes-ai.com/v1
auth: AGNES_API_KEY
models: agnes-2.5-flash
updated: 2026-08-19
---

# Agnes

本项目默认的模型提供商。端点用 **OpenAI 兼容** 的 `POST /chat/completions`，默认模型 `agnes-2.5-flash`。

## 接入

```text
AGNES_API_KEY=...
# 可选覆盖
AGENT_BASE_URL=https://apihub.agnes-ai.com/v1
AGENT_MODEL=agnes-2.5-flash
```

## 注意

- 兼容选项：`AGENT_BASE_URL` / `AGENT_MODEL` / 通用 `AGENT_API_KEY`。
- 未配置 `AGNES_API_KEY` 时工具照常注册，但模型请求会失败；联网搜索还需 `EXA_API_KEY`。
- 支持 SSE 流式，工具调用的参数即使分片也会拼装完整后再执行。
