---
title: DeepSeek
id: deepseek
category: providers
type: provider
status: reference
proto: openai-compatible
endpoint: https://api.deepseek.com
auth: DEEPSEEK_API_KEY
models: deepseek-v4-pro-0813, deepseek-v4-flash（均以官方文档为准）
updated: 2026-08-19
source: https://api-docs.deepseek.com/
related: ["../MOC.md"]
---

# DeepSeek

OpenAI 兼容接口，`/chat/completions` 可直接使用。当前主线为 **DeepSeek V4** 系列。

## 官方文档（agent 请自行查阅）

- 文档首页 / API 参考：https://api-docs.deepseek.com/
- 模型与定价：https://api-docs.deepseek.com/quick_start/pricing
- 对话补全接口：https://api-docs.deepseek.com/api/create-chat-completion
- 错误码 / 限流：https://api-docs.deepseek.com/quick_start/error_codes

> ⚠️ 进行任何涉及 DeepSeek 的任务前，先 `web_search` 或 `fetch` 上面的官方文档，
> 核对**当前 V4 模型的准确标识、端点与价格**，不要照搬本文档示例；必要时更新本文件的
> `models` 和 `updated` 字段。

## 接入

```text
AGENT_BASE_URL=https://api.deepseek.com
AGENT_MODEL=<当前 V4 模型标识，以官方文档为准>
AGENT_API_KEY=$DEEPSEEK_API_KEY
```

## V4 要点

- 旗舰为 **DeepSeek-V4-Pro-0813**，主打 **Agent 任务**（来源：本项目 `docs/ai-news/2026-08.md`）。
- V4 起 API 价格大幅上调（峰值时段最高涨幅约 1,100%），调用前以官方定价页为准。
- 旧模型 `deepseek-chat` / `deepseek-reasoner` 已移除，请勿再引用。
- 鉴权用 `Authorization: Bearer`，与 OpenAI 相同；function calling 是否保留、
  `reasoning_content` 等非标准字段的行为，以官方文档为准。

## V4 Flash（待补充准确规格）

V4 家族还包括 **Flash 档位**，定位偏轻量/高速（具体能力、上下文与价格以官方为准）。

```text
AGENT_BASE_URL=https://api.deepseek.com
AGENT_MODEL=<deepseek-v4-flash 准确模型标识，待核实>
AGENT_API_KEY=$DEEPSEEK_API_KEY
```

| 项目 | 值（待补充） |
|---|---|
| 准确模型标识 | 待补充 |
| 上下文长度 | 待补充 |
| 输入/输出价格 | 待补充 |
| 是否支持 function calling | 待补充 |
| 与 V4-Pro 的差异 | 待补充 |

> 以上字段需对照 https://api-docs.deepseek.com/quick_start/pricing 填写后再移除“待补充”。

> 说明：本文档的 V4 具体型号与价格未逐一联网核实，只记录"需以官方文档为准"的要点；
> 最终以官方页面为依据。
