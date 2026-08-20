---
title: LLM Wiki 条目元数据规范
id: wiki-metadata-schema
category: meta
type: specification
status: verified
updated: 2026-08-21
source: internal
related: ["../README.md", "../MOC.md"]
---

# 条目元数据规范

所有 `kb/` 原子条目必须使用 YAML front matter。元数据用于导航、筛选和判断时效，不替代正文事实。

## 必填字段

| 字段 | 约束 |
|---|---|
| `title` | 人类可读标题 |
| `id` | 与文件名一致的稳定小写 slug |
| `category` | 例如 `providers`、`meta` |
| `type` | 例如 `provider`、`specification`、`navigation` |
| `status` | `verified`、`reference` 或 `needs-review` |
| `updated` | `YYYY-MM-DD` |
| `source` | 官方 URL、`internal` 或明确来源 |

## Provider 条目字段

Provider 条目额外包含 `proto`、`endpoint`、`auth`、`models` 和 `related`。`native` 协议不能仅通过修改 Base URL 接入本项目，必须在 `src/model/` 增加适配层。

## 正文规则

- 一篇条目只描述一个 Provider 或一个稳定主题。
- 先写可直接使用的事实，再写限制和待核实项。
- 不保存 API Key、Token、原始对话、临时测试输出或猜测。
- 不复制其他条目正文；使用相对路径链接。
- 供应商参数、价格和模型列表变化时更新 `updated` 和 `source`。
