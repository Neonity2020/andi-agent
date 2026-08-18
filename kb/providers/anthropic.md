---
title: Anthropic Claude
category: providers
proto: native
endpoint: https://api.anthropic.com
auth: ANTHROPIC_API_KEY
models: claude-sonnet-4, claude-opus-4, claude-haiku
updated: 2026-08-19
---

# Anthropic Claude

采用 **原生 Messages API**（`POST /v1/messages`），**与 OpenAI 兼容格式不通用**。

## 协议差异

- 端点：`https://api.anthropic.com/v1/messages`
- 鉴权：`x-api-key: <key>`（非 `Authorization: Bearer`）
- 请求头还需 `anthropic-version: 2023-06-01`
- 工具调用字段与角色格式不同（`tool_use` / `tool_result` 内容块）

## 接入本项目的障碍

本项目 `src/model/openai-compatible.ts` 只发 OpenAI 风格 `chat/completions`。
**直接覆盖 `AGENT_BASE_URL` 无法切换 Claude** —— 需在 `src/model/` 新增一个
`AnthropicProvider` 适配层（实现 `ModelProvider` 接口）并处理上述差异后才可用。

## 注意

- 模型名带版本后缀（如 `claude-sonnet-4-YYYYMMDD`），以官方为准。
