# Coding Agent 构建培训 · 半天 Workshop 大纲

> 基于 `coding-agent-training` SKILL · v1.0 · 半天（4 小时）· 中级及以上工程师

---

## 设计简报

- **目标**：让学员从零搭建一个可工作的 Coding Agent，掌握 prompt + tool + loop + skill + memory 五大支柱
- **学习者**：中级及以上工程师，已熟悉 TypeScript / async I/O，对 LLM API 有基础认知
- **形式与总时长**：半天 workshop（4 小时，含 2 次休息），理论讲解 ~50% + 动手练习 ~50%
- **成功证据**：每个学员在 M5 结束时拥有一个能调用工具、加载 skill、跨会话记忆的最小 agent，并跑通 6 个里程碑的测试
- **约束与假设**：
  - 学员使用 macOS / Linux，已装 Node.js 20+ 和 pnpm
  - 提供 OpenAI / Anthropic API key（环境变量 `.env`）
  - 工作目录：`./training/coding-agent/`，每个学员独立分支
  - 语言：中英混排，关键术语保留英文
  - 无障碍：所有幻灯片有等效文本

---

## 学习目标

完成培训后，学习者能够：

1. **解释** Coding Agent 的五大支柱（prompt / tool / loop / skill / memory）如何协作，以及每一层解决了上一层的哪个失败模式
2. **设计** 类型化的 tool schema，包含输入输出契约、错误处理、幂等性声明
3. **实现** 一个带有终止条件、消息历史、token 预算的 agent loop
4. **编写** 一个 SKILL.md，包含 YAML frontmatter、触发短语、可观察的决策规则
5. **使用** durable memory 实现跨会话的上下文恢复，并能区分 remember / archive 的边界
6. **诊断** 常见 agent 失败模式（无护栏删除、无限循环、上下文膨胀、错误触发）

---

## 培训大纲

| 时间 | 模块 | 学习者要解决的问题 | 关键内容 | 活动/练习 | 检查点或产出 | 对应目标 |
|---|---|---|---|---|---|---|
| 09:00–09:20 (20m) | 开场 & 上下文 | "为什么现在要学 Coding Agent？" | 行业现状、失败案例、今天要交付的最小 agent | 自我介绍 + 配对 | 写下个人学习目标 | — |
| 09:20–09:32 (12m) | 支柱 1：Prompt | "prompt 怎么变成可执行契约？" | system / user / tool description 三段式；persona、约束、输出格式、refusal | 现场改写一段 prompt 并跑出不同结果 | M0 starter | 1 |
| 09:32–09:42 (10m) | 动手 M0 | "没有工具的 agent 是什么样？" | `callModel(prompt) → string` | 跑通 M0（echo 用户消息） | M0 测试通过 | 1 |
| 09:42–09:54 (12m) | 支柱 2：Tool | "tool schema 应该多严？" | JSON Schema、命名、错误、幂等、副作用 | 现场给一个反例，让模型拒答或报错 | tool schema v1 | 2 |
| 09:54–10:14 (20m) | 动手 M1–M2 | "加了 read / edit 后能做什么？" | `read_file`、`edit_file`（带 diff check） | M1 列文件并展示；M2 跨文件重构 | M1、M2 测试通过 | 2 |
| 10:14–10:30 (16m) | 休息 + 答疑 | — | — | — | — | — |
| 10:30–10:42 (12m) | 支柱 3：Loop | "loop 怎么停？" | 终止条件、消息历史、token 预算、cancellation | 现场演示一个不收敛的 case 并加 `maxSteps` | loop skeleton | 3 |
| 10:42–11:02 (20m) | 动手 M3 | "run 命令的安全边界在哪？" | 沙箱化 `run_command`、审批流、超时 | M3 跑测试并总结失败 | M3 测试通过 | 3 |
| 11:02–11:14 (12m) | 支柱 4：Skill | "skill 和 prompt 有什么区别？" | YAML frontmatter、触发短语、`disable-model-invocation`、references/scripts/assets 约定 | 现场对比一段 prompt vs 一个 SKILL.md | skill skeleton | 4 |
| 11:14–11:34 (20m) | 动手 M4 | "怎么让 agent 主动加载 skill？" | SKILL.md 解析器、skill manager、触发匹配 | M4 端到端调用 `pdf-to-markdown` skill | M4 测试通过 | 4 |
| 11:34–11:46 (12m) | 支柱 5：Memory | "哪些该记、哪些该忘？" | remember / archive / 检索 tags、expected_updated 协议 | 现场演示一个错误覆盖 vs 正确归档 | memory skeleton | 5 |
| 11:46–12:06 (20m) | 动手 M5 | "跨会话怎么恢复？" | memory 加载、handoff、resume | M5 从昨天的 memory 恢复会话 | M5 测试通过 | 5 |
| 12:06–12:20 (14m) | 常见坑实战 | "真实失败长什么样？" | 5 个失败模式 + 恢复策略 | Failure autopsy：分析一段真实 trace | 标注 ≥3 个 guardrail | 6 |
| 12:20–12:30 (10m) | 收尾 & 下一步 | "接下来学什么？" | 自评清单、production checklist、社区资源 | 填写自评表 + 拍照 | 完成度自评 ≥80% | 1–6 |

**总时长核对**：20+12+10+12+20+16+12+20+12+20+12+20+14+10 = **240 分钟 = 4 小时** ✅

---

## 培训后的应用

### 工作场景中的下一步

- **D+1**：在团队内 fork 半天项目，补完测试和文档，1 周内合并到主分支
- **D+7**：选一个真实痛点（如 `kb/` 检索、`test/` 生成），用本套骨架实现第一个 production-ready agent
- **D+30**：建立团队的 SKILL.md 仓库，覆盖 ≥5 个高频 workflow

### 支持材料或跟进机制

- **Slack/微信群**：培训后保持 2 周活跃答疑
- **GitHub 仓库**：`training/coding-agent/` starter code + 完整 solution 分支
- **Office Hours**：每周一次 1 小时视频答疑，持续 4 周
- **Skill Library**：把本次的 `coding-agent-training` SKILL 作为团队模板

### 效果观察方式

- **现场**：每个里程碑的测试通过率（目标 ≥85%）
- **D+30**：学员是否提交了第一个 production agent PR
- **D+90**：团队是否新增 ≥3 个 SKILL.md 到 `.agents/skills/`

---

## 自评清单（学员填写）

完成一项打 ✓：

- [ ] 我能说出 prompt / tool / loop / skill / memory 五大支柱及其依赖关系
- [ ] 我能写出至少 3 个 tool 的完整 JSON Schema
- [ ] 我能解释为什么 `maxSteps` 和 `cancelToken` 缺一不可
- [ ] 我能区分 `disable-model-invocation: true` 与 `false` 的适用场景
- [ ] 我能在 `memory_remember` 和 `memory_archive` 之间做出正确选择
- [ ] 我能从一段 trace 中识别出至少 3 个常见失败模式
- [ ] 我的 starter repo 通过了 M0–M5 的全部测试
- [ ] 我能为团队下一个真实 workflow 写一个 SKILL.md

**得分**：≥7 项 → 可独立上手；5–6 项 → 需要 1 周密集练习；≤4 项 → 建议重新参加培训

---

## 待确认项

- [ ] 受众是否需要降低门槛（如增加 TypeScript 速成 30 分钟）？
- [ ] 是否提供 OpenAI / Anthropic API key 报销或统一发放？
- [ ] 学员机器是否需要预装 Docker（用于沙箱化 `run_command`）？
- [ ] 半天是否拆成两个 2 小时 session（避免一次疲劳）？
- [ ] 是否录制视频供事后回看？

---

## 配套文件清单

- ✅ `SKILL.md` — 本 skill 主文件
- 📦 `references/halfday-workshop.md` — 本文件（半天 workshop 大纲）
- 📦 `references/fullday-workshop.md` — 全天版（待生成）
- 📦 `references/exercises.md` — M0–M5 练习题（待生成）
- 📦 `references/facilitator-script.md` — 讲师脚本（待生成）

> 📌 **设计说明**（5 条最重要的取舍）：
> 1. **理论 50% + 动手 50%**：避免纯 lecture，也避免一上来就 8 小时写代码
> 2. **每个里程碑 15–20 分钟**：保证学员能"刚好做完"而非做不完
> 3. **失败模式独立成块**（12:06–12:20）：让学员在收尾前把"反面教材"内化
> 4. **5 个常见坑用真实 trace 演示**：而不是念 PPT，更容易记住
> 5. **D+1 / D+7 / D+30 应用节点**：把培训效果延伸到 3 个月，避免"听完就忘"