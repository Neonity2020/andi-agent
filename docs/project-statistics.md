# andi-agent 项目规模统计

统计日期：2026-08-19

统计范围：当前工作区，包含尚未提交的长期记忆实现；排除 `.git/`、`node_modules/`、`.andi-agent/` 等依赖或运行状态目录。

## 代码与文档规模

| 类别 | 文件数 | 行数 |
| --- | ---: | ---: |
| `src/` TypeScript | 40 | 5,701 |
| `test/` TypeScript | 34 | 3,073 |
| TypeScript 合计 | 74 | 8,774 |
| `.plans/` | 10 | 1,071 |
| `kb/` | 13 | 431 |
| `.memory/` | 2 | 118 |
| `docs/` | 6 | 未统计文本行数 |

测试代码约为源码行数的 54%。最近一次完整验证包含 176 个测试用例，结果为 176 pass、0 fail；TypeScript 类型检查与 `git diff --check` 均通过。

## 源码模块分布

| 模块 | 行数 |
| --- | ---: |
| 根级核心模块 | 1,535 |
| `src/tui/` | 1,393 |
| `src/tools/` | 1,238 |
| `src/scheduler/` | 640 |
| `src/memory/` | 524 |
| `src/model/` | 279 |
| `src/runtime/` | 92 |

最大单文件为 `src/cli.ts`（557 行），其次是 `src/tui/tui.ts`（419 行）、`src/tui/input.ts`（381 行）、`src/memory/store.ts`（339 行）、`src/session.ts`（269 行）和 `src/agent.ts`（265 行）。

## Agent 能力规模

- 默认注册 18 个模型工具；配置 Exa 后为 19 个。
- 工具覆盖文件读写、代码搜索、命令执行、Git、定时任务、长期记忆和网页搜索。
- 长期记忆支持自动召回、显式读写、可恢复归档和 scheduled Agent 只读策略。
- REPL 支持持久 session、TUI、usage 统计、恢复和长期记忆查询。

## 工程状态

- 当前分支：`main`。
- Git 提交数：9。
- 已跟踪文件：101；未跟踪文件：16。
- 统计时有 20 个已跟踪文件被修改，长期记忆实现尚未提交。
- 运行时依赖：Puppeteer。
- 开发依赖：TypeScript 与 Bun 类型。

总体上，andi-agent 是一个约 5,700 行核心源码、8,800 行 TypeScript 总量的小型但功能完整的 coding agent 项目。
