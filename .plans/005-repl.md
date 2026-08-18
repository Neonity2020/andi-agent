# 第五阶段：常驻 REPL

## 1. 目标

提供一个长期运行的交互式终端会话，在同一进程内复用 Agent、模型适配器、工具注册表、命令审批通道和对话历史。

启动方式：

```bash
bun run start -- --repl --session my-project
```

也允许提供第一条任务后继续进入 REPL：

```bash
bun run start -- --repl --session my-project "先分析项目结构"
```

## 2. 运行模型

- REPL 启动时只创建一次 Workspace、工具、Agnes provider 和 Agent；
- 每条用户输入调用一次 `Agent.runWithHistory`；
- 成功后用返回的 messages 替换内存历史，并立即原子保存 session；
- 单轮失败只打印错误并返回提示符，不终止整个 REPL，也不覆盖上一次成功历史；
- 不指定 `--session` 时，历史只存在于当前进程内；
- 指定 session 时，启动时加载历史，退出后可继续恢复。

## 3. 输入与审批协调

REPL 和命令审批必须共享同一个 readline interface。Agent 执行期间 REPL 不读取下一条用户输入，因此审批问题可以安全地临时接管同一终端：

```text
you> 安装缺失依赖并运行测试
Approve command ["bun","install"]? [y/N]
```

- `--approval ask`：共享终端逐条询问；
- `--approval never`：白名单外命令直接拒绝；
- `--repl` 要求交互式 TTY，避免管道输入与审批争抢 stdin。

## 4. 内置命令

- `/help`：显示 REPL 命令；
- `/status`：显示 session ID 和当前消息数；
- `/clear`：清空内存历史，并把空历史保存到当前 session；
- `/exit`、`/quit`：正常退出；
- 空输入：忽略并重新显示提示符。

以 `/` 开头但未知的输入返回提示，不发送给模型。需要让模型处理以 `/` 开头的文本时，可在前面增加普通说明文字。

## 5. 流式输出

每条用户任务开始前重置流式输出状态：

- Agnes token 继续实时写入 stdout；
- Agent 和工具状态写入 stderr；
- 若供应商未返回 delta，则在任务结束后打印完整 output；
- 前一轮是否产生流式 token 不影响下一轮的输出决策。

## 6. 退出与错误

- Ctrl-D 或 `/exit`：关闭 readline 并退出；
- Ctrl-C 在等待输入时视为退出；
- API、工具或最大轮次错误：打印 `[error]`，保留上一次成功的 history；
- session 加载失败在进入 REPL 前终止，避免覆盖损坏数据。

本阶段不实现 Agent 执行中途的 Ctrl-C 取消；AbortSignal 会在后续运行时取消阶段统一接入模型请求和子进程。

## 7. 实施步骤

1. 抽取可测试的 `runRepl` 循环与 REPL IO 接口。
2. 扩展 CLI 参数解析，支持 `--repl` 和可选初始任务。
3. 让 REPL 与命令审批共享 readline。
4. 为事件 reporter 增加每轮 reset。
5. 接入内存历史和逐轮 session 保存。
6. 增加内置命令、失败恢复和 EOF 行为测试。
7. 更新 README、运行类型检查、完整测试和 CLI 冒烟检查。

## 8. 验收标准

- 同一 REPL 中第二条任务能看到第一条任务的消息历史；
- 有 session 时每轮成功后保存，重启后可以恢复；
- `/clear` 同时清空内存和持久化历史；
- 单轮失败后仍能继续下一轮；
- 审批与 REPL 不创建两个竞争 stdin 的 readline；
- 连续两轮流式/非流式输出不会相互影响；
- 所有现有单次 CLI 行为保持兼容。
