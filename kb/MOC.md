---
title: MOC — 模型提供商内容地图
category: moc
proto: index
endpoint: n/a
auth: n/a
models: n/a
updated: 2026-08-19
---

# Map of Content — 模型提供商

> 内容地图：不重复文档正文，只做**主题聚合与选型导航**。当「知道要做什么、但不确定找哪篇」时，
> 从这里出发；确认目标后加载对应单篇文档。配合 `kb/README.md`（按清单视角）互补使用。

---

## 主题链路：按「需求 → 打开哪篇」导航

| 我的需求 / 约束 | 优先看 | 备选 |
|---|---|---|
| 开箱即用、项目默认 | `providers/agnes.md` | — |
| 直接替换默认、走 OpenAI 兼容 | `providers/openai.md` | `providers/deepseek.md` |
| 需要超长上下文 (128k) | `providers/moonshot.md` | — |
| 本地运行 / 离线 / 隐私 | `providers/ollama.md` | — |
| 极低延迟 | `providers/groq.md` | — |
| 低成本批量 | `providers/zhipu.md` | `providers/deepseek.md` |
| 托管开源模型 | `providers/together.md` | `providers/groq.md` |
| 闭源旗舰级能力 | `providers/openai.md` | `providers/mistral.md` |
| 只用原生协议（需新增适配层） | `providers/anthropic.md` · `providers/gemini.md` | — |

---

## 聚合视角一：按线协议

**openai-compatible —— 可直接用 `AGENT_BASE_URL` / `AGENT_MODEL` / `AGENT_API_KEY` 切换**
`agnes` · `openai` · `deepseek` · `moonshot` · `zhipu` · `mistral` · `groq` · `together` · `ollama`

**native —— 需在 `src/model/` 新增适配层，不能仅靠改 URL**
`anthropic`（`/v1/messages`）· `gemini`（`generateContent`）

## 聚合视角二：按场景族

- **默认 / 托管 API：** `agnes`，`openai`，`mistral`，`deepseek`
- **中文 / 国内可直连：** `zhipu`，`moonshot`，`deepseek`
- **本地自托管：** `ollama`
- **推理速度优先：** `groq`
- **开源模型聚合：** `together`，`groq`
- **原生协议（待适配）：** `anthropic`，`gemini`

---

## 术语速查（协议字段对照）

| 本知识库字段 | 含义 |
|---|---|
| `proto: openai-compatible` | 端点走 OpenAI `chat/completions`，可直接接入本项目 |
| `proto: native` | 端点走厂商自有协议，需适配层 |
| `auth` | 环境变量名；项目读取 `AGENT_API_KEY` / `AGNES_API_KEY` |
| `endpoint` | base URL，不含路径尾斜杠 |

---

## 维护约定

- 新增提供商文档时，同步在本 MOC 的「主题链路」与两个「聚合视角」登记，并更新 `kb/README.md` 目录。
- MOC 保持**只做导航、不复制正文**，避免知识重复、保证按需加载时上下文精简。
