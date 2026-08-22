#!/usr/bin/env bun
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { basename } from "node:path";
import { Agent, type AgentEvent } from "./agent";
import { loadConfig, type AgentConfig } from "./config";
import { createModelProvider, ModelProviderRouter, providerConfig } from "./model/providers";
import { ModelCatalogManager } from "./model/catalog-manager";
import { ModelCatalogStore } from "./model/catalog-store";
import { ModelSelectionStore, applyPersistedModelSelection, createPersistingModelManager } from "./model/selection-store";
import { REPL_COMMANDS, runRepl, type ReplIO } from "./repl";
import { SessionStore } from "./session";
import { createCommandTool, runCommand, type CommandApprover } from "./tools/command";
import { createEditTool } from "./tools/editing";
import { createGitTools } from "./tools/git";
import { ToolRegistry } from "./tools/registry";
import { createSearchTool } from "./tools/search";
import { Workspace, createWorkspaceTools } from "./tools/workspace";
import { createSchedulerTools } from "./tools/scheduler";
import { createWebSearchTool } from "./tools/web-search";
import { createWeatherTool } from "./tools/weather";
import { isCancellationError, throwIfAborted } from "./runtime/abort";
import { applyInstallEnv } from "./runtime/env";
import { addRunUsage, emptyRunUsage } from "./usage";
import { RunRecorder } from "./runtime/recorder";
import { parseScheduleArguments, parseSchedulerArguments } from "./scheduler/parser";
import { createScheduledAgentRunner } from "./scheduler/runner";
import { TaskScheduler } from "./scheduler/scheduler";
import { ScheduleStore } from "./scheduler/store";
import type { ScheduledTask } from "./scheduler/types";
import { Tui } from "./tui/tui";
import { MemoryStore } from "./memory/store";
import { createMemoryTools } from "./tools/memory";
import { SkillManager } from "./skills/manager";
import { KnowledgeStore } from "./knowledge/store";
import { createKnowledgeTools } from "./tools/knowledge";

const HELP = `andi-agent - 基于 Bun + TypeScript 的轻量 Coding Agent

用法：
  andi                               在当前工作区启动 REPL
  bun run src/cli.ts [--cwd 路径] [--session 会话ID] [--approval ask|never] <任务>
  bun run src/cli.ts --repl [--cwd 路径] [--session 会话ID] [初始任务]
  bun run src/cli.ts schedule add ID (--at 时间 | --every 间隔) [--session 会话ID] -- <任务>
  bun run src/cli.ts schedule list
  bun run src/cli.ts schedule remove ID
  bun run src/cli.ts schedule run ID
  bun run src/cli.ts scheduler [--cwd 路径] [--poll 间隔]

选项：
  --cwd 路径          工作区根目录（默认：当前目录）
  --session 会话ID    加载并保存本地对话会话（REPL 默认：default）
  --approval 模式     命令审批模式：ask（默认）或 never
  --repl              启动持久交互会话（默认使用 TUI）
  --plain             使用经典 readline REPL，不使用 TUI
  --log-events        将脱敏运行事件写入 .andi-agent/runs/
  -h, --help          显示帮助

环境变量：
  AGENT_PROVIDER    模型 Provider：agnes（默认）或 minimax
  AGNES_API_KEY     Agnes API Key（Agnes 必填，也接受 AGENT_API_KEY）
  MINIMAX_API_KEY   MiniMax 国内版 API Key（MiniMax 必填）
  AGENT_MODEL       模型名称（默认值取决于 Provider）
  AGENT_BASE_URL    API Base URL（默认值取决于 Provider）
  AGENT_MAX_TURNS   最大模型轮数（默认：12）
  AGENT_MAX_CONTEXT_CHARS  近似上下文预算（默认：120000）
  EXA_API_KEY       可选的 Exa Key，启用 web_search 工具
  EXA_BASE_URL      Exa API Base URL（默认：https://api.exa.ai）`;

const SCHEDULE_EVENT_TYPES = new Set(["turn_started", "tool_started", "tool_completed", "agent_completed"]);
const DEFAULT_REPL_SESSION_ID = "default";

interface CliArguments {
  cwd: string;
  task: string | undefined;
  session: string | undefined;
  approval: "ask" | "never";
  repl: boolean;
  plain: boolean;
  logEvents: boolean;
}

interface Questioner {
  question(prompt: string, fresh?: boolean, signal?: AbortSignal): Promise<string | null>;
}

export function renderReadlinePrompt(
  terminal: Pick<ReadlineInterface, "setPrompt" | "prompt">,
  prompt: string,
): void {
  terminal.setPrompt(prompt);
  terminal.prompt();
}

class TerminalChannel implements Questioner {
  readonly #terminal: ReadlineInterface;
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | null) => void> = [];
  #closed = false;
  #interruptHandler: () => void = () => this.close();

  constructor() {
    this.#terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    this.#terminal.on("line", (line) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
      else this.#lines.push(line);
    });
    this.#terminal.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
    this.#terminal.on("SIGINT", () => this.#interruptHandler());
  }

  async question(prompt: string, fresh = false, signal?: AbortSignal): Promise<string | null> {
    if (!fresh) {
      const queued = this.#lines.shift();
      if (queued !== undefined) return queued;
    }
    if (this.#closed) return null;
    if (signal?.aborted) return null;
    renderReadlinePrompt(this.#terminal, prompt);
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (line: string | null): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abortWaiter);
        resolve(line);
      };
      const abortWaiter = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        waiter(null);
      };
      signal?.addEventListener("abort", abortWaiter, { once: true });
      this.#waiters.push(waiter);
    });
  }

  onInterrupt(handler: () => void): void {
    this.#interruptHandler = handler;
  }

  close(): void {
    if (!this.#closed) this.#terminal.close();
    process.stdin.pause();
  }
}

export function parseArguments(args: readonly string[]): CliArguments {
  let cwd = process.cwd();
  let session: string | undefined;
  let approval: "ask" | "never" = "ask";
  let repl = false;
  let plain = false;
  let logEvents = false;
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--cwd") {
      const value = args[index + 1];
      if (!value) throw new Error("--cwd 需要一个路径");
      cwd = value;
      index += 1;
    } else if (argument === "--session") {
      const value = args[index + 1];
      if (!value) throw new Error("--session 需要一个 ID");
      session = value;
      index += 1;
    } else if (argument === "--approval") {
      const value = args[index + 1];
      if (value !== "ask" && value !== "never") throw new Error("--approval 必须是 'ask' 或 'never'");
      approval = value;
      index += 1;
    } else if (argument === "--repl") {
      repl = true;
    } else if (argument === "--plain") {
      plain = true;
    } else if (argument === "--log-events") {
      logEvents = true;
    } else if (argument?.startsWith("-")) {
      throw new Error(`未知选项：${argument}`);
    } else if (argument) {
      taskParts.push(argument);
    }
  }

  const task = taskParts.join(" ").trim() || undefined;
  if (!repl && !task) throw new Error("除非使用 --repl，否则必须提供任务");
  return {
    cwd,
    task,
    session,
    approval,
    repl,
    plain,
    logEvents,
  };
}

export function resolveSessionId(options: Pick<CliArguments, "repl" | "session">): string | undefined {
  return options.session ?? (options.repl ? DEFAULT_REPL_SESSION_ID : undefined);
}

function createTerminalApprover(
  mode: "ask" | "never",
  sharedTerminal?: Questioner,
): CommandApprover | undefined {
  if (mode === "never" || !process.stdin.isTTY) return undefined;
  return async (command, signal) => {
    if (sharedTerminal) {
      const answer = await sharedTerminal.question(
        `\n批准命令 ${JSON.stringify(command)}? [y/N] `,
        true,
        signal,
      );
      throwIfAborted(signal);
      return answer !== null && (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    }
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await new Promise<string>((resolve) => {
        terminal.question(`\n批准命令 ${JSON.stringify(command)}? [y/N] `, resolve);
      });
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    } finally {
      terminal.close();
    }
  };
}

function createEventReporter(): {
  report: (event: AgentEvent) => void;
  didStreamText: () => boolean;
  reset: () => void;
  finish: () => void;
} {
  let streamedText = false;
  let streamLineOpen = false;
  const report = (event: AgentEvent): void => {
    if (event.type === "model_text_delta") {
      process.stdout.write(event.delta);
      streamedText = true;
      streamLineOpen = true;
      return;
    }
    if (event.type === "model_completed" && streamLineOpen) {
      process.stdout.write("\n");
      streamLineOpen = false;
    }

    switch (event.type) {
    case "turn_started":
      console.error(`[Agent] 第 ${event.turn} 轮 · ${event.messageCount} 条消息`);
      break;
    case "model_completed":
      console.error(
        `[Agent] 模型完成 · ${event.toolCallCount} 次工具调用 · ${event.durationMs}ms${event.usage ? ` · ${event.usage.totalTokens} Token${event.usage.cachedInputTokens ? ` · 缓存命中 ${event.usage.cachedInputTokens} Token` : ""}` : ""}`,
      );
      break;
    case "tool_started":
      console.error(`[工具] ${event.toolName} 开始执行`);
      break;
    case "tool_completed":
      console.error(`[工具] ${event.toolName} ${event.ok ? "执行完成" : "执行失败"} · ${event.durationMs}ms`);
      break;
    case "context_compacted":
      console.error(`[Agent] 上下文已压缩 · 丢弃 ${event.droppedMessages} 条旧消息`);
      break;
    case "memory_context_loaded":
      console.error(`[记忆] 加载 ${event.ids.length} 条 · ${event.chars} 字符`);
      break;
    case "memory_context_failed":
      console.error(`[记忆] 不可用 · ${event.error}`);
      break;
    case "agent_completed":
      console.error(`[Agent] 已完成 · 共 ${event.turns} 轮`);
      break;
    case "agent_cancelled":
      console.error("[Agent] 当前轮次已取消");
      break;
    case "agent_failed":
      console.error(`[Agent] 执行失败 · ${event.error}`);
    }
  };
  const finish = (): void => {
    if (streamLineOpen) process.stdout.write("\n");
    streamLineOpen = false;
  };
  return {
    report,
    didStreamText: () => streamedText,
    finish,
    reset() {
      finish();
      streamedText = false;
    },
  };
}

async function handleScheduleCommand(args: readonly string[]): Promise<void> {
  const command = parseScheduleArguments(args);
  const workspace = await Workspace.create(command.cwd);
  const store = new ScheduleStore(workspace);

  if (command.action === "add") {
    const task = await store.add(command.input);
    console.log(`已创建定时任务“${task.id}” · 下次运行：${task.nextRunAt}`);
    return;
  }
  if (command.action === "list") {
    const tasks = await store.list();
    if (tasks.length === 0) {
      console.log("暂无定时任务。");
      return;
    }
    for (const task of tasks) console.log(formatScheduledTask(task));
    return;
  }
  if (command.action === "remove") {
    if (!(await store.remove(command.id))) throw new Error(`Scheduled task '${command.id}' does not exist`);
    console.log(`已删除定时任务“${command.id}”。`);
    return;
  }

  if (!(await store.get(command.id))) throw new Error(`Scheduled task '${command.id}' does not exist`);
  const lifecycle = createProcessAbortController("Scheduled task cancelled by user");
  try {
    const scheduler = new TaskScheduler({
      store,
      runner: await createCliScheduledRunner(workspace),
    });
    const completed = await scheduler.runNow(command.id, lifecycle.controller.signal);
    if (completed.lastRun?.status === "failed") throw new Error(completed.lastRun.error ?? "Scheduled task failed");
  } finally {
    lifecycle.dispose();
  }
}

async function handleSchedulerCommand(args: readonly string[]): Promise<void> {
  const command = parseSchedulerArguments(args);
  const workspace = await Workspace.create(command.cwd);
  const store = new ScheduleStore(workspace);
  const lifecycle = createProcessAbortController("Scheduler stopped by user");
  const scheduler = new TaskScheduler({
    store,
    runner: await createCliScheduledRunner(workspace),
    pollMs: command.pollMs,
    onError(task, error) {
      console.error(`[定时任务：${task.id}] 执行失败 · ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  console.error(`[调度器] 已启动 · 工作区：${workspace.root} · 轮询：${command.pollMs}ms`);
  try {
    await scheduler.start(lifecycle.controller.signal);
  } catch (error) {
    if (!isCancellationError(error) && !lifecycle.controller.signal.aborted) throw error;
  } finally {
    lifecycle.dispose();
    console.error("[调度器] 已停止");
  }
}

async function createCliScheduledRunner(workspace: Workspace) {
  return createScheduledAgentRunner({
    workspace,
    config: loadConfig(),
    skills: await SkillManager.load(workspace.root),
    onEvent(taskId, event) {
      if (!SCHEDULE_EVENT_TYPES.has(event.type)) return;
      if (event.type === "turn_started") {
        console.error(`[定时任务：${taskId}] 第 ${event.turn} 轮开始`);
      } else if (event.type === "tool_started") {
        console.error(`[定时任务：${taskId}] 工具 ${event.toolName} 开始执行`);
      } else if (event.type === "tool_completed") {
        console.error(`[定时任务：${taskId}] 工具 ${event.toolName}${event.ok ? "执行完成" : "执行失败"}`);
      } else if (event.type === "agent_completed") {
        console.error(`[定时任务：${taskId}] 已完成 · 共 ${event.turns} 轮`);
      }
    },
    onResult(taskId, output) {
      console.log(`[schedule:${taskId}] ${output}`);
    },
  });
}

function formatScheduledTask(task: ScheduledTask): string {
  const schedule = task.schedule.kind === "once" ? `at ${task.schedule.at}` : `every ${task.schedule.everyMs}ms`;
  const next = task.nextRunAt ?? "none";
  const last = task.lastRun?.status ?? "never";
  return `${task.id}\t${task.enabled ? "enabled" : "disabled"}\t${schedule}\tnext=${next}\tlast=${last}\tsession=${task.sessionId}`;
}

function createProcessAbortController(message: string): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error(message));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    controller,
    dispose() {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    },
  };
}

export function createAgentToolRegistry(
  workspace: Workspace,
  config: AgentConfig,
  approver?: CommandApprover,
  memory = new MemoryStore(workspace),
  skills?: SkillManager,
): ToolRegistry {
  const approvalOptions = approver ? { approver } : {};
  const scheduleStore = new ScheduleStore(workspace);
  const conversationalScheduledRunner = createScheduledAgentRunner({
    workspace,
    config,
    ...(skills ? { skills } : {}),
  });
  return new ToolRegistry([
    ...createWorkspaceTools(workspace),
    createEditTool(workspace),
    createSearchTool(workspace.root),
    createCommandTool(workspace.root, approvalOptions),
    ...createGitTools(workspace, approvalOptions),
    ...createSchedulerTools(scheduleStore, { runner: conversationalScheduledRunner }),
    ...createMemoryTools(memory),
    ...createKnowledgeTools(new KnowledgeStore(workspace)),
    ...(config.exa ? [createWebSearchTool(config.exa)] : []),
    createWeatherTool(),
  ]);
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  await applyInstallEnv();
  if (args.length === 0) args = ["--repl"];
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  if (args[0] === "schedule") {
    await handleScheduleCommand(args.slice(1));
    return;
  }
  if (args[0] === "scheduler") {
    await handleSchedulerCommand(args.slice(1));
    return;
  }

  const cli = parseArguments(args);
  const sessionId = resolveSessionId(cli);
  if (cli.repl && !process.stdin.isTTY) throw new Error("--repl requires an interactive TTY");
  const config = loadConfig();
  const workspace = await Workspace.create(cli.cwd);
  const memory = new MemoryStore(workspace);
  const useTui =
    cli.repl && !cli.plain && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const terminal = cli.repl && !useTui ? new TerminalChannel() : undefined;
  let approver = createTerminalApprover(cli.approval, terminal);
  let tui: Tui | undefined;
  if (useTui) {
    tui = new Tui({
      stdin: process.stdin,
      sink: process.stdout,
      columns: () => process.stdout.columns || 80,
      rows: () => process.stdout.rows || 24,
      commands: REPL_COMMANDS,
      status: {
        model: `${config.provider ?? "agnes"}/${config.model}`,
        session: sessionId ?? "memory-only",
        cwd: basename(workspace.root),
      },
      colorEnabled: !process.env.NO_COLOR,
    });
    approver = cli.approval === "ask" ? tui.approve : undefined;
  }
  const skills = await SkillManager.load(workspace.root, {
    executeCommand: async (command, cwd) => {
      const result = await runCommand(cwd, "sh", ["-c", command], 30_000, 64 * 1024, approver);
      if (result.exitCode !== 0) throw new Error(`Skill context command failed (${result.exitCode}): ${result.stderr}`);
      return result.stdout;
    },
  });
  const configuredProviders = Object.keys(config.providers ?? {}) as Array<"agnes" | "minimax">;
  const providerInstances = new Map<"agnes" | "minimax", ReturnType<typeof createModelProvider>>();
  const catalogManagers = new Map<"agnes" | "minimax", ModelCatalogManager>();
  for (const provider of configuredProviders) {
    const settings = providerConfig(config, provider);
    if (!settings) continue;
    const instance = createModelProvider({ ...settings, provider });
    providerInstances.set(provider, instance);
    catalogManagers.set(provider, new ModelCatalogManager({
      providerId: provider,
      source: settings.baseUrl,
      provider: instance,
      store: new ModelCatalogStore(workspace),
    }));
  }
  const initialProvider = config.provider ?? "agnes";
  const model = new ModelProviderRouter({ providers: providerInstances, catalogs: catalogManagers, initialProvider });
  const selectionStore = new ModelSelectionStore(workspace);
  const selectionRestored = await applyPersistedModelSelection({
    router: model,
    catalogs: catalogManagers,
    selection: await selectionStore.load().catch(() => undefined),
  });
  if (selectionRestored && tui) tui.setModel(`${model.currentProvider}/${model.currentModel}`);
  const models = createPersistingModelManager(model, selectionStore);

  const tools = createAgentToolRegistry(workspace, config, approver, memory, skills);
  const reporter = createEventReporter();
  const recorder = cli.logEvents ? new RunRecorder(workspace) : undefined;
  const agent = new Agent({
    model,
    tools,
    memory,
    skills,
    maxTurns: config.maxTurns,
    maxContextChars: config.maxContextChars,
    async onEvent(event) {
      if (tui) tui.handleAgentEvent(event);
      else reporter.report(event);
      await recorder?.record(event);
    },
  });

  const sessions = sessionId ? new SessionStore(workspace) : undefined;
  const sessionSnapshot = sessionId ? await sessions?.loadSnapshot(sessionId) : undefined;
  const history = sessionSnapshot?.messages ?? [];
  if (cli.repl && tui) {
    tui.start();
    try {
      await runRepl({
        agent,
        io: tui,
        memory,
        skills,
        models,
        onModelChanged: (selected) => tui.setModel(`${model.currentProvider}/${selected}`),
        initialHistory: history,
        initialUsage: sessionSnapshot?.usage ?? emptyRunUsage(),
        ...(cli.task ? { initialTask: cli.task } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sessions ? { sessionStore: sessions } : {}),
        beforeTask: () => tui.beginRun(),
        onResult: (result) => tui.handleResult(result),
      });
    } finally {
      tui.close();
    }
    return;
  }
  if (cli.repl && terminal) {
    const io: ReplIO = {
      async read(prompt) {
        return terminal.question(prompt);
      },
      write(message) {
        console.error(message);
      },
      error(message) {
        console.error(message);
      },
      onInterrupt(handler) {
        terminal.onInterrupt(handler);
      },
      close() {
        terminal.close();
      },
    };
    try {
      await runRepl({
        agent,
        io,
        memory,
        skills,
        models,
        initialHistory: history,
        initialUsage: sessionSnapshot?.usage ?? emptyRunUsage(),
        ...(cli.task ? { initialTask: cli.task } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sessions ? { sessionStore: sessions } : {}),
        beforeTask: reporter.reset,
        onError: reporter.finish,
        onResult(result) {
          reporter.finish();
          if (!reporter.didStreamText()) console.log(result.output);
        },
      });
    } finally {
      terminal.close();
    }
    return;
  }

  reporter.reset();
  let result;
  const baseUsage = sessionSnapshot?.usage ?? emptyRunUsage();
  try {
    result = await agent.runWithHistory(cli.task as string, history, {
      ...(sessionId && sessions
        ? {
            onCheckpoint: (checkpoint) =>
              sessions.saveCheckpoint(sessionId, checkpoint, addRunUsage(baseUsage, checkpoint.usage)),
          }
        : {}),
    });
  } catch (error) {
    reporter.finish();
    throw error;
  }
  reporter.finish();
  if (!reporter.didStreamText()) console.log(result.output);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
