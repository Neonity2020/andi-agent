#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { Agent, type AgentEvent } from "./agent";
import { loadConfig } from "./config";
import { OpenAICompatibleProvider } from "./model/openai-compatible";
import { SessionStore } from "./session";
import { createCommandTool, type CommandApprover } from "./tools/command";
import { createEditTool } from "./tools/editing";
import { createGitTools } from "./tools/git";
import { ToolRegistry } from "./tools/registry";
import { createSearchTool } from "./tools/search";
import { Workspace, createWorkspaceTools } from "./tools/workspace";

const HELP = `andi-agent - a minimal Bun + TypeScript coding agent

Usage:
  bun run src/cli.ts [--cwd PATH] [--session ID] [--approval ask|never] <task>

Options:
  --cwd PATH          Workspace root (default: current directory)
  --session ID        Load and save a local conversation session
  --approval MODE     Command approval mode: ask (default) or never
  -h, --help          Show this help

Environment:
  AGNES_API_KEY     Agnes API key (required; AGENT_API_KEY is also accepted)
  AGENT_MODEL       Model name (default: agnes-2.5-flash)
  AGENT_BASE_URL    API base URL (default: https://apihub.agnes-ai.com/v1)
  AGENT_MAX_TURNS   Maximum model turns (default: 12)
  AGENT_MAX_CONTEXT_CHARS  Approximate context budget (default: 120000)`;

interface CliArguments {
  cwd: string;
  task: string;
  session: string | undefined;
  approval: "ask" | "never";
}

export function parseArguments(args: readonly string[]): CliArguments {
  let cwd = process.cwd();
  let session: string | undefined;
  let approval: "ask" | "never" = "ask";
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
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument) {
      taskParts.push(argument);
    }
  }

  const task = taskParts.join(" ").trim();
  if (task.length === 0) throw new Error("A task is required");
  return { cwd, task, session, approval };
}

function createTerminalApprover(mode: "ask" | "never"): CommandApprover | undefined {
  if (mode === "never" || !process.stdin.isTTY) return undefined;
  return async (command) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await terminal.question(`\nApprove command ${JSON.stringify(command)}? [y/N] `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    } finally {
      terminal.close();
    }
  };
}

function createEventReporter(): { report: (event: AgentEvent) => void; didStreamText: () => boolean } {
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
      console.error(`[agent] model completed · ${event.toolCallCount} tool call(s)`);
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
    case "agent_completed":
      console.error(`[agent] completed in ${event.turns} turn(s)`);
    }
  };
  return { report, didStreamText: () => streamedText };
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  const cli = parseArguments(args);
  const config = loadConfig();
  const workspace = await Workspace.create(cli.cwd);
  const approver = createTerminalApprover(cli.approval);
  const approvalOptions = approver ? { approver } : {};
  const tools = new ToolRegistry([
    ...createWorkspaceTools(workspace),
    createEditTool(workspace),
    createSearchTool(workspace.root),
    createCommandTool(workspace.root, approvalOptions),
    ...createGitTools(workspace, approvalOptions),
  ]);
  const model = new OpenAICompatibleProvider(config);
  const reporter = createEventReporter();
  const agent = new Agent({
    model,
    tools,
    maxTurns: config.maxTurns,
    maxContextChars: config.maxContextChars,
    onEvent: reporter.report,
  });

  const sessions = cli.session ? new SessionStore(workspace) : undefined;
  const history = cli.session ? await sessions?.load(cli.session) : [];
  const result = await agent.runWithHistory(cli.task, history);
  if (cli.session) await sessions?.save(cli.session, result.messages);

  if (!reporter.didStreamText()) console.log(result.output);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
