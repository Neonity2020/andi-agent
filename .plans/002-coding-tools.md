# 第二阶段：安全编码工具

## 1. 目标

在现有 Agnes 2.5 Flash 工具调用闭环上补齐真正完成编码任务所需的两项能力：精确编辑文件、执行项目验证命令。

本阶段完成后，Agent 应能：

1. 读取并定位现有代码；
2. 使用精确文本替换修改文件；
3. 执行测试、类型检查和只读 Git 命令；
4. 根据命令输出继续修复；
5. 在超时、输出过长或命令不在策略内时安全停止。

## 2. 设计

### 2.1 `edit_file`

使用结构化参数 `path`、`old_text`、`new_text`，而不是让模型直接生成难以稳定解析的 shell heredoc。

- `old_text` 必须在文件中恰好出现一次；
- 找不到或出现多次都拒绝修改，并把错误返回模型；
- 替换先在内存中完成，再复用 `Workspace.write` 的路径与符号链接防护；
- 完整重写仍由已有 `write_file` 提供。

这种设计使小范围修改可预测，也能阻止模糊匹配改错位置。

### 2.2 `run_command`

命令以 `program + args[]` 传递，直接使用 `Bun.spawn`，不经过 shell，因此 `|`、重定向、命令替换等不会被解释。

默认命令策略：

- `bun test`
- `bun run test|typecheck|lint|check|build`
- `npm test`
- `npm run test|typecheck|lint|check|build`
- `tsc --noEmit`

从第四阶段开始，Git 操作改由专用的 `git_status`、`git_diff`、`git_stage` 和 `git_commit` 工具处理，以显式禁用可能执行仓库配置程序的 Git 扩展。

限制：

- 工作目录固定为 Agent workspace；
- 默认超时 30 秒，允许请求 1–120 秒；
- stdout/stderr 分别最多保留 64 KiB，超出部分注明已截断；
- 超时后终止子进程；
- 不允许 `npx`、shell、安装、发布、Git 写操作或任意脚本名。

### 2.3 Agent 指令

系统提示增加工作规范：修改前读取、优先使用 `edit_file`、修改后运行适用验证、不要声称未执行的检查已通过。

## 3. 目录变化

```text
src/tools/
├── command.ts       # 命令策略、进程执行、输出限制
├── editing.ts       # 精确文件替换工具
├── registry.ts
├── types.ts
└── workspace.ts

test/
├── command.test.ts
├── editing.test.ts
└── ...
```

## 4. 实施步骤

1. 实现精确替换工具及零匹配、多匹配测试。
2. 实现命令策略，覆盖允许和拒绝案例。
3. 使用 `Bun.spawn` 实现无 shell 命令执行、超时和输出截断。
4. 将新工具注册到 CLI，并从公共入口导出。
5. 更新系统提示、README 和真实 Agnes 测试说明。
6. 执行 Bun 测试、TypeScript 类型检查、CLI 帮助检查和差异检查。

## 5. 验收标准

- `edit_file` 只能进行唯一、确定的文本替换；
- 目录穿越和符号链接保护继续有效；
- 未授权命令在创建子进程前被拒绝；
- 允许的测试命令能返回退出码、stdout、stderr 和超时状态；
- `bun test` 与 `bun run typecheck` 通过；
- Agnes 能在真实任务中看到并调用新增工具。

## 6. 后续阶段

- 交互式命令审批和持久化策略；
- 流式模型输出与工具执行事件；
- 会话历史持久化、上下文压缩；
- Git 补丁预览与提交工作流；
- MCP/LSP 工具接入。
