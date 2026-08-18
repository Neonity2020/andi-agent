---
title: 智谱 GLM (BigModel)
category: providers
proto: openai-compatible
endpoint: https://open.bigmodel.cn/api/paas/v4
auth: ZHIPU_API_KEY
models: glm-4-plus, glm-4-flash, glm-4-air
updated: 2026-08-19
---

# 智谱 GLM (BigModel)

OpenAI 兼容接口。

## 接入

```text
AGENT_BASE_URL=https://open.bigmodel.cn/api/paas/v4
AGENT_MODEL=glm-4-flash
AGENT_API_KEY=$ZHIPU_API_KEY
```

## 注意

- 鉴权用 Bearer Token，与 OpenAI 一致；也支持 JWT 方式但本项目用 Bearer 即可。
- `glm-4-flash` 免费/低成本，适合批量；`glm-4-plus` 能力更强。
- 兼容模式支持 function calling 与流式。
