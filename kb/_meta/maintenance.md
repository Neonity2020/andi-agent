---
title: LLM Wiki 维护流程
id: wiki-maintenance
category: meta
type: procedure
status: verified
updated: 2026-08-21
source: internal
related: ["../README.md", "../MOC.md", "schema.md"]
---

# 维护流程

## 新增条目

1. 确认主题不能由现有条目清晰覆盖。
2. 创建一个单主题 Markdown 文件，先写完整 front matter。
3. 只记录可验证事实和当前项目接入方式。
4. 在 `MOC.md` 和 `kb/README.md` 登记。
5. 运行项目测试，并检查 Markdown 链接和日期。

## 更新条目

1. 先读取现有条目和 `MOC.md`。
2. 对照官方文档或 API 实际响应核实变化。
3. 更新正文、`updated`、`status` 和 `source`。
4. 检查是否影响 `config.ts`、Provider 适配器或 README。

## 质量门槛

- MOC 中每个条目路径都存在。
- 每个 Provider 文件都有唯一 `id`。
- 不把整个知识库注入 system prompt。
- 不把知识库内容伪装成当前实时状态。
- 当前用户指令和真实工具结果优先于 KB 条目。
