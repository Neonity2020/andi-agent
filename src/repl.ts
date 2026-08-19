import type { AgentCheckpoint, AgentRunOptions, AgentRunResult } from "./agent";
import type { Message, RunUsage } from "./model/types";
import { isCancellationError } from "./runtime/abort";
import { repairIncompleteToolCalls } from "./session";
import { addRunUsage, emptyRunUsage } from "./usage";
import type { MemoryDocument, MemoryMatch, MemorySummary } from "./memory/types";

export interface ReplAgent {
  runWithHistory(
    task: string,
    history?: readonly Message[],
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
}

export interface ReplSessionStore {
  save(id: string, messages: readonly Message[]): Promise<void>;
  saveCheckpoint?(id: string, checkpoint: AgentCheckpoint, totalUsage: RunUsage): Promise<void>;
}

export interface ReplIO {
  read(prompt: string): Promise<string | null>;
  write(message: string): void;
  error(message: string): void;
  onInterrupt?(handler: () => void): void;
  close?(): void;
}

export interface ReplMemoryStore {
  list(signal?: AbortSignal): Promise<MemorySummary[]>;
  search(query: string, limit?: number, signal?: AbortSignal): Promise<MemoryMatch[]>;
  read(id: string, signal?: AbortSignal): Promise<MemoryDocument>;
}

export interface ReplOptions {
  agent: ReplAgent;
  io: ReplIO;
  initialHistory?: readonly Message[];
  initialUsage?: RunUsage;
  initialTask?: string;
  sessionId?: string;
  sessionStore?: ReplSessionStore;
  memory?: ReplMemoryStore;
  beforeTask?: () => void;
  onResult?: (result: AgentRunResult) => void;
  onError?: () => void;
}

const REPL_HELP = `/help     Show REPL commands
/status   Show session, run, and history status
/usage    Show token and model timing totals
/recover  Repair incomplete tool-call history
/clear    Clear in-memory and persisted conversation history
/memory [list]          List durable workspace memories
/memory search <query>  Search durable workspace memories
/memory show <id>       Show one durable workspace memory
/exit     Exit the REPL`;

export async function runRepl(options: ReplOptions): Promise<Message[]> {
  let history = [...(options.initialHistory ?? [])];
  let sessionUsage = { ...(options.initialUsage ?? emptyRunUsage()) };
  let lastRunUsage = emptyRunUsage();
  let pendingTask = options.initialTask?.trim() || undefined;
  let activeController: AbortController | undefined;
  let activeRunId: string | undefined;
  let exitRequested = false;
  options.io.write(`andi-agent REPL · session: ${options.sessionId ?? "memory-only"}`);
  options.io.write("Type /help for commands.");

  options.io.onInterrupt?.(() => {
    if (activeController && !activeController.signal.aborted) {
      options.io.error("Cancelling current turn...");
      activeController.abort(new Error("Cancelled by user"));
      return;
    }
    exitRequested = true;
    options.io.close?.();
  });

  const persistHistory = async (): Promise<void> => {
    if (!options.sessionId || !options.sessionStore) return;
    try {
      if (options.sessionStore.saveCheckpoint) {
        await options.sessionStore.saveCheckpoint(
          options.sessionId,
          {
            runId: activeRunId ?? "manual",
            state: "idle",
            messages: history,
            usage: emptyRunUsage(),
          },
          sessionUsage,
        );
      } else {
        await options.sessionStore.save(options.sessionId, history);
      }
    } catch (error) {
      options.io.error(`[error] Failed to save session: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  while (!exitRequested) {
    const input = pendingTask ?? (await options.io.read("you> "));
    pendingTask = undefined;
    if (input === null) break;
    const task = input.trim();
    if (task.length === 0) continue;

    if (task.startsWith("/")) {
      if (task === "/exit" || task === "/quit") break;
      if (task === "/help") {
        options.io.write(REPL_HELP);
        continue;
      }
      if (task === "/status") {
        options.io.write(
          `session: ${options.sessionId ?? "memory-only"} · state: ${activeController ? "running" : "idle"} · messages: ${history.length}`,
        );
        continue;
      }
      if (task === "/usage") {
        options.io.write(`last run: ${formatUsage(lastRunUsage)}`);
        options.io.write(`session: ${formatUsage(sessionUsage)}`);
        continue;
      }
      if (task === "/recover") {
        const repaired = repairIncompleteToolCalls(history);
        history = repaired.messages;
        await persistHistory();
        options.io.write(`Recovery complete · repaired ${repaired.repairedToolResults} missing tool result(s).`);
        continue;
      }
      if (task === "/clear") {
        history = [];
        sessionUsage = emptyRunUsage();
        lastRunUsage = emptyRunUsage();
        await persistHistory();
        options.io.write("Conversation history cleared.");
        continue;
      }
      if (task === "/memory" || task === "/memory list") {
        if (!options.memory) {
          options.io.error("Long-term memory is unavailable.");
          continue;
        }
        try {
          const memories = await options.memory.list();
          if (memories.length === 0) options.io.write("No long-term memories.");
          else {
            for (const memory of memories) {
              options.io.write(`${memory.id}\t${memory.title}\t${memory.tags.join(", ") || "no tags"}`);
            }
          }
        } catch (error) {
          options.io.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (task.startsWith("/memory search ")) {
        if (!options.memory) {
          options.io.error("Long-term memory is unavailable.");
          continue;
        }
        try {
          const query = task.slice("/memory search ".length).trim();
          const matches = await options.memory.search(query, 10);
          if (matches.length === 0) options.io.write("No matching memories.");
          else {
            for (const match of matches) {
              options.io.write(`${match.id}\t${match.score.toFixed(2)}\t${match.title}\n${match.snippet}`);
            }
          }
        } catch (error) {
          options.io.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (task.startsWith("/memory show ")) {
        if (!options.memory) {
          options.io.error("Long-term memory is unavailable.");
          continue;
        }
        try {
          const memory = await options.memory.read(task.slice("/memory show ".length).trim());
          options.io.write(`# ${memory.title}\n\n${memory.content}`);
        } catch (error) {
          options.io.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      options.io.error(`Unknown REPL command: ${task}. Type /help for commands.`);
      continue;
    }

    options.beforeTask?.();
    activeController = new AbortController();
    const baseUsage = { ...sessionUsage };
    try {
      const result = await options.agent.runWithHistory(task, history, {
        signal: activeController.signal,
        onCheckpoint: async (checkpoint) => {
          activeRunId = checkpoint.runId;
          history = checkpoint.messages;
          lastRunUsage = checkpoint.usage;
          sessionUsage = addRunUsage(baseUsage, checkpoint.usage);
          if (!options.sessionId || !options.sessionStore?.saveCheckpoint) return;
          try {
            await options.sessionStore.saveCheckpoint(
              options.sessionId,
              checkpoint,
              addRunUsage(baseUsage, checkpoint.usage),
            );
          } catch (error) {
            options.io.error(
              `[error] Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      });
      history = result.messages;
      lastRunUsage = result.usage;
      sessionUsage = addRunUsage(baseUsage, result.usage);
      if (options.onResult) options.onResult(result);
      else options.io.write(result.output);
      await persistHistory();
    } catch (error) {
      options.onError?.();
      if (isCancellationError(error)) options.io.write("Turn cancelled.");
      else options.io.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeController = undefined;
      activeRunId = undefined;
    }
  }

  options.io.write("REPL closed.");
  return history;
}

function formatUsage(usage: RunUsage): string {
  return `${usage.inputTokens} input · ${usage.outputTokens} output · ${usage.totalTokens} total tokens · ${usage.modelRequests} request(s) · ${usage.modelDurationMs}ms`;
}
