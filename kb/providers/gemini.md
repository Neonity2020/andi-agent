---
title: Google Gemini
category: providers
proto: native
endpoint: https://generativelanguage.googleapis.com/v1beta
auth: GEMINI_API_KEY
models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash
updated: 2026-08-19
---

# Google Gemini

采用 **原生 `generateContent` API**，**与 OpenAI 兼容格式不通用**。

## 协议差异

- 端点：`https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
- 鉴权：`x-goog-api-key: <key>`
- 请求/响应为 Google 自有的 `contents` / `parts` 结构
- 工具声明用 `functionDeclarations`，字段名与 OpenAI 不同

## 接入本项目的障碍

同样无法通过覆盖 `AGENT_BASE_URL` 直接切换，需新增 Gemini 适配层实现 `ModelProvider`。

## 注意

- 部分模型提供 OpenAI 兼容端点（`/v1beta/openai/`），若可用也可走 OpenAI 兼容路径。
