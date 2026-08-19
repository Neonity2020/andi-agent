#!/usr/bin/env bun
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { basename } from "node:path";
import { Agent, type AgentEvent } from "./agent";
import { loadConfig, type AgentConfig } from "./config";
import { OpenAICompatibleProvider } from "./model/openai-compatible";
import { runRepl, type ReplIO } from "./repl";
import { SessionStore } from "./session";
import { createCommandTool, type CommandApprover } from "./tools/command";
import { createEditTool } from "./tools/editing";
import { createGitTools } from "./tools/git";
import { ToolRegistry } from "./tools/registry";
import { createSearchTool } from "./tools/search";
import { Workspace, createWorkspaceTools } from "./tools/workspace";
import { createSchedulerTools } from "./tools/scheduler";
import { createWebSearchTool } from "./tools/web-search";
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

const HELP = `andi-agent - a minimal Bun + TypeScript coding agent

Usage:
  andi                               start a REPL in the current workspace
  bun run src/cli.ts [--cwd PATH] [--session ID] [--approval ask|never] <task>
  bun run src/cli.ts --repl [--cwd PATH] [--session ID] [initial task]
  bun run src/cli.ts schedule add ID (--at TIME | --every DURATION) [--session ID] -- <task>
  bun run src/cli.ts schedule list
  bun run src/cli.ts schedule remove ID
  bun run src/cli.ts schedule run ID
  bun run src/cli.ts scheduler [--cwd PATH] [--poll DURATION]

Options:
  --cwd PATH          Workspace root (default: current directory)
  --session ID        Load and save a local conversation session
  --approval MODE     Command approval mode: ask (default) or never
  --repl              Start a persistent interactive session (TUI by default)
  --plain             Use the classic readline REPL instead of the TUI
  --log-events        Write sanitized run events under .andi-agent/runs/
  -h, --help          Show this help

Environment:
  AGNES_API_KEY     Agnes API key (required; AGENT_API_KEY is also accepted)
  AGENT_MODEL       Model name (default: agnes-2.5-flash)
  AGENT_BASE_URL    API base URL (default: https://apihub.agnes-ai.com/v1)
  AGENT_MAX_TURNS   Maximum model turns (default: 12)
  AGENT_MAX_CONTEXT_CHARS  Approximate context budget (default: 120000)
  EXA_API_KEY       Optional Exa key that enables the web_search tool
  EXA_BASE_URL      Exa API base URL (default: https://api.exa.ai)`;

const SCHEDULE_EVENT_TYPES = new Set(["turn_started", "tool_started", "tool_completed", "agent_completed"]);

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
      if (!value) throw new Error("--cwd requires a path");
      cwd = value;
      index += 1;
    } else if (argument === "--session") {
      const value = args[index + 1];
      if (!value) throw new Error("--session requires an ID");
      session = value;
      index += 1;
    } else if (argument === "--approval") {
      const value = args[index + 1];
      if (value !== "ask" && value !== "never") throw new Error("--approval must be 'ask' or 'never'");
      approval = value;
      index += 1;
    } else if (argument === "--repl") {
      repl = true;
    } else if (argument === "--plain") {
      plain = true;
    } else if (argument === "--log-events") {
      logEvents = true;
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument) {
      taskParts.push(argument);
    }
  }

  const task = taskParts.join(" ").trim() || undefined;
  if (!repl && !task) throw new Error("A task is required unless --repl is used");
  return { cwd, task, session, approval, repl, plain, logEvents };
}

function createTerminalApprover(
  mode: "ask" | "never",
  sharedTerminal?: Questioner,
): CommandApprover | undefined {
  if (mode === "never" || !process.stdin.isTTY) return undefined;
  return async (command, signal) => {
    if (sharedTerminal) {
      const answer = await sharedTerminal.question(
        `\nApprove command ${JSON.stringify(command)}? [y/N] `,
        true,
        signal,
      );
      throwIfAborted(signal);
      return answer !== null && (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    }
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await new Promise<string>((resolve) => {
        terminal.question(`\nApprove command ${JSON.stringify(command)}? [y/N] `, resolve);
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
      console.error(`[agent] turn ${event.turn} · ${event.messageCount} messages`);
      break;
    case "model_completed":
      console.error(
        `[agent] model completed · ${event.toolCallCount} tool call(s) · ${event.durationMs}ms${event.usage ? ` · ${event.usage.totalTokens} tokens` : ""}`,
      );
      break;
    case "tool_started":
      console.error(`[tool] ${event.toolName} started`);
      break;
    case "tool_completed":
      console.error(`[tool] ${event.toolName} ${event.ok ? "completed" : "failed"} · ${event.durationMs}ms`);
      break;
    case "context_compacted":
      console.error(`[agent] context compacted · dropped ${event.droppedMessages} old message(s)`);
      break;
    case "memory_context_loaded":
      console.error(`[memory] loaded ${event.ids.length} note(s) · ${event.chars} chars`);
      break;
    case "memory_context_failed":
      console.error(`[memory] unavailable · ${event.error}`);
      break;
    case "agent_completed":
      console.error(`[agent] completed in ${event.turns} turn(s)`);
      break;
    case "agent_cancelled":
      console.error("[agent] turn cancelled");
      break;
    case "agent_failed":
      console.error(`[agent] failed · ${event.error}`);
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
    console.log(`Scheduled '${task.id}' · next run ${task.nextRunAt}`);
    return;
  }
  if (command.action === "list") {
    const tasks = await store.list();
    if (tasks.length === 0) {
      console.log("No scheduled tasks.");
      return;
    }
    for (const task of tasks) console.log(formatScheduledTask(task));
    return;
  }
  if (command.action === "remove") {
    if (!(await store.remove(command.id))) throw new Error(`Scheduled task '${command.id}' does not exist`);
    console.log(`Removed scheduled task '${command.id}'.`);
    return;
  }

  if (!(await store.get(command.id))) throw new Error(`Scheduled task '${command.id}' does not exist`);
  const lifecycle = createProcessAbortController("Scheduled task cancelled by user");
  try {
    const scheduler = new TaskScheduler({
      store,
      runner: createCliScheduledRunner(workspace),
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
    runner: createCliScheduledRunner(workspace),
    pollMs: command.pollMs,
    onError(task, error) {
      console.error(`[schedule:${task.id}] failed · ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  console.error(`[scheduler] started · workspace ${workspace.root} · poll ${command.pollMs}ms`);
  try {
    await scheduler.start(lifecycle.controller.signal);
  } catch (error) {
    if (!isCancellationError(error) && !lifecycle.controller.signal.aborted) throw error;
  } finally {
    lifecycle.dispose();
    console.error("[scheduler] stopped");
  }
}

function createCliScheduledRunner(workspace: Workspace) {
  return createScheduledAgentRunner({
    workspace,
    config: loadConfig(),
    onEvent(taskId, event) {
      if (!SCHEDULE_EVENT_TYPES.has(event.type)) return;
      if (event.type === "turn_started") {
        console.error(`[schedule:${taskId}] turn ${event.turn} started`);
      } else if (event.type === "tool_started") {
        console.error(`[schedule:${taskId}] tool ${event.toolName} started`);
      } else if (event.type === "tool_completed") {
        console.error(`[schedule:${taskId}] tool ${event.toolName} ${event.ok ? "completed" : "failed"}`);
      } else if (event.type === "agent_completed") {
        console.error(`[schedule:${taskId}] completed in ${event.turns} turn(s)`);
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
): ToolRegistry {
  const approvalOptions = approver ? { approver } : {};
  const scheduleStore = new ScheduleStore(workspace);
  const conversationalScheduledRunner = createScheduledAgentRunner({ workspace, config });
  return new ToolRegistry([
    ...createWorkspaceTools(workspace),
    createEditTool(workspace),
    createSearchTool(workspace.root),
    createCommandTool(workspace.root, approvalOptions),
    ...createGitTools(workspace, approvalOptions),
    ...createSchedulerTools(scheduleStore, { runner: conversationalScheduledRunner }),
    ...createMemoryTools(memory),
    ...(config.exa ? [createWebSearchTool(config.exa)] : []),
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
      status: {
        model: config.model,
        session: cli.session ?? "memory-only",
        cwd: basename(workspace.root),
      },
      colorEnabled: !process.env.NO_COLOR,
    });
    approver = cli.approval === "ask" ? tui.approve : undefined;
  }
  const tools = createAgentToolRegistry(workspace, config, approver, memory);
  const model = new OpenAICompatibleProvider(config);
  const reporter = createEventReporter();
  const recorder = cli.logEvents ? new RunRecorder(workspace) : undefined;
  const agent = new Agent({
    model,
    tools,
    memory,
    maxTurns: config.maxTurns,
    maxContextChars: config.maxContextChars,
    async onEvent(event) {
      if (tui) tui.handleAgentEvent(event);
      else reporter.report(event);
      await recorder?.record(event);
    },
  });

  const sessions = cli.session ? new SessionStore(workspace) : undefined;
  const sessionSnapshot = cli.session ? await sessions?.loadSnapshot(cli.session) : undefined;
  const history = sessionSnapshot?.messages ?? [];
  if (cli.repl && tui) {
    tui.start();
    try {
      await runRepl({
        agent,
        io: tui,
        memory,
        initialHistory: history,
        initialUsage: sessionSnapshot?.usage ?? emptyRunUsage(),
        ...(cli.task ? { initialTask: cli.task } : {}),
        ...(cli.session ? { sessionId: cli.session } : {}),
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
        initialHistory: history,
        initialUsage: sessionSnapshot?.usage ?? emptyRunUsage(),
        ...(cli.task ? { initialTask: cli.task } : {}),
        ...(cli.session ? { sessionId: cli.session } : {}),
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
      ...(cli.session && sessions
        ? {
            onCheckpoint: (checkpoint) =>
              sessions.saveCheckpoint(cli.session as string, checkpoint, addRunUsage(baseUsage, checkpoint.usage)),
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
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
