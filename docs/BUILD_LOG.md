# 构建日志 · 2026-08-19

> 本次会话创建并部署了 2 个 SKILL，生成了培训大纲文档。

---

## 1. SKILL 创建记录

| SKILL 名称 | 路径 | 行数 | 大小 | 状态 | 说明 |
|---|---|---|---|---|---|
| `skill-creator` | `.agents/skills/skill-creator/SKILL.md` | — | — | ✅ 已存在 | 原有 skill，本次无修改 |
| `pdf-to-markdown` | `.agents/skills/pdf-to-markdown/SKILL.md` | 98 | 4.5 KB | ✅ 新建 | PDF 转 Markdown 转换工具 |
| `coding-agent-training` | `.agents/skills/coding-agent-training/SKILL.md` | 130 | 7.2 KB | ✅ 新建 | Coding Agent 构建培训课程模板 |

---

## 2. 参考文档生成

| 文件名 | 路径 | 行数 | 说明 |
|---|---|---|---|
| `halfday-workshop.md` | `.agents/skills/coding-agent-training/references/halfday-workshop.md` | 120 | 半天 workshop 大纲（内部引用） |
| `coding-agent-training-workshop.md` | `coding-agent-training-workshop.md`（根目录） | 122 | 副本，可直接打开预览 |

---

## 3. Git 变更摘要

| 文件 / 目录 | 操作 | 说明 |
|---|---|---|
| `.agents/skills/pdf-to-markdown/` | `??`（新增） | 新 SKILL |
| `.agents/skills/coding-agent-training/` | `??`（新增） | 新 SKILL + references |
| `coding-agent-training-workshop.md` | `??`（新增） | 大纲副本（根目录） |
| `.agents/skills/skill-creator/SKILL.md` | `A`（已暂存） | 原 skill |
| `.memory/sources.md` | `M` | 更新最后更新日期 |
| `src/skills/manager.ts` | `A`（已暂存） | skill 管理器 |
| `test/skills.test.ts` | `A`（已暂存） | skill 测试 |
| 其他源文件 | `M` | 日常开发提交 |

---

## 4. 培训大纲核心内容

### 4.1 5 大支柱

| 支柱 | 关键概念 | 里程碑 |
|---|---|---|
| Prompt | system / user / tool description 三段式 | M0 |
| Tool | JSON Schema、幂等、副作用 | M1–M2 |
| Loop | 终止条件、token 预算、cancelToken | M3 |
| Skill | YAML frontmatter、触发短语 | M4 |
| Memory | remember / archive / expected_updated | M5 |

### 4.2 时间分配（半天 4 小时）

| 时段 | 占比 | 说明 |
|---|---|---|
| 理论讲解 | ~50% | 5 大支柱逐层展开 |
| 动手练习 | ~40% | M0–M5 渐进式实操 |
| 休息 + 答疑 | ~5% | 16 分钟中间休息 |
| 收尾 & 自评 | ~5% | Failure autopsy + 自评清单 |

---

## 5. 下一步计划

| 优先级 | 任务 | 预计产出 |
|---|---|---|
| P0 | 生成 M0–M5 练习题（含 TypeScript starter code） | `references/exercises.md` |
| P1 | 生成讲师脚本（每分钟讲解要点） | `references/facilitator-script.md` |
| P2 | 生成全天版大纲（6h 版本） | `references/fullday-workshop.md` |
| P3 | 幻灯片骨架（14 个时段拆分） | `references/slides.md` |

---

## 6. 备注

- 所有 SKILL 遵循 `.agents/skills/<name>/SKILL.md` 规范
- 培训大纲采用中英混排，关键术语保留英文
- 自评清单支持 3 档评估：≥7 项独立上手，5–6 项需练习，≤4 项重训
- 效果观察节点：现场 ≥85% 通过率 / D+30 PR / D+90 新增 3+ skills

---

*日志创建于 2026-08-19 · 基于当前 git 状态生成*