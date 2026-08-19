import type { AgentCheckpoint, AgentRunOptions, AgentRunResult } from "./agent";
import type { Message, RunUsage } from "./model/types";
import type { ModelCatalogEntry } from "./model/types";
import { isCancellationError } from "./runtime/abort";
import { repairIncompleteToolCalls } from "./session";
import { addRunUsage, emptyRunUsage } from "./usage";
import type { MemoryDocument, MemoryMatch, MemorySummary } from "./memory/types";
import type { AgentProvider } from "./config";
import type { SkillInvocation, SkillSummary } from "./skills/manager";

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
  select?(options: ReplSelectOptions): Promise<string | null>;
  write(message: string): void;
  error(message: string): void;
  onInterrupt?(handler: () => void): void;
  onExit?(handler: () => void): void;
  close?(): void;
}

export interface ReplSelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface ReplSelectOptions {
  title: string;
  items: readonly ReplSelectItem[];
  selectedValue?: string;
}

export interface ReplMemoryStore {
  list(signal?: AbortSignal): Promise<MemorySummary[]>;
  search(query: string, limit?: number, signal?: AbortSignal): Promise<MemoryMatch[]>;
  read(id: string, signal?: AbortSignal): Promise<MemoryDocument>;
}

export interface ReplModelManager {
  readonly currentModel: string;
  readonly currentProvider?: AgentProvider;
  availableProviders?(): readonly AgentProvider[];
  selectProvider?(provider: AgentProvider): void | Promise<void>;
  listAllModels?(signal?: AbortSignal, refresh?: boolean): Promise<readonly ReplQualifiedModel[]>;
  selectQualifiedModel?(provider: AgentProvider, id: string): void | Promise<void>;
  listModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]>;
  refreshModels?(signal?: AbortSignal): Promise<ModelCatalogEntry[]>;
  selectModel(id: string): void | Promise<void>;
}

export interface ReplSkillManager {
  list(): readonly SkillSummary[];
  parseInvocation(input: string): Promise<SkillInvocation | undefined>;
  issues?(): readonly { path: string; error: string }[];
}

export interface ReplQualifiedModel extends ModelCatalogEntry {
  provider: AgentProvider;
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
  models?: ReplModelManager;
  skills?: ReplSkillManager;
  onModelChanged?: (model: string) => void;
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
/models                 Select a cached Chat Completions model
/models refresh         Refresh the current provider's model cache
/provider               Show configured model providers
/provider <id>          Switch provider (for example: /provider minimax)
/skills                 List discovered skills
/<skill-name> [args]     Invoke a skill explicitly
/exit     Exit the REPL
Ctrl-D    Exit immediately from any TUI state`;

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
  options.io.onExit?.(() => {
    exitRequested = true;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort(new Error("Exited by user"));
    }
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
          `session: ${options.sessionId ?? "memory-only"} · model: ${options.models?.currentProvider ? `${options.models.currentProvider}/` : ""}${options.models?.currentModel ?? "unknown"} · state: ${activeController ? "running" : "idle"} · messages: ${history.length}`,
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
      if (task === "/skills") {
        if (!options.skills) {
          options.io.error("Skills are unavailable.");
          continue;
        }
        const skills = options.skills.list();
        if (skills.length === 0) options.io.write("No skills discovered.");
        else {
          for (const skill of skills) {
            const invocation = skill.userInvocable ? `/${skill.name}` : "(model only)";
            options.io.write(`${invocation}\t${skill.description} · ${skill.source}`);
          }
        }
        for (const issue of options.skills.issues?.() ?? []) {
          options.io.error(`[skill] skipped ${issue.path}: ${issue.error}`);
        }
        continue;
      }
      if (task === "/models" || task === "/models refresh") {
        if (!options.models) {
          options.io.error("Model switching is unavailable.");
          continue;
        }
        const modelManager = options.models;
        const refresh = task === "/models refresh";
        const refreshModels = modelManager.refreshModels;
        if (refresh && !refreshModels) {
          options.io.error("Model catalog refresh is unavailable.");
          continue;
        }
        const listController = new AbortController();
        activeController = listController;
        let models: ModelCatalogEntry[];
        let qualifiedModels: readonly ReplQualifiedModel[] | undefined;
        try {
          if (modelManager.listAllModels) {
            qualifiedModels = await modelManager.listAllModels.call(modelManager, listController.signal, refresh);
            models = [...qualifiedModels];
          } else {
            models = refresh
              ? await refreshModels!.call(options.models, listController.signal)
              : await modelManager.listModels.call(modelManager, listController.signal);
          }
        } catch (error) {
          if (isCancellationError(error)) options.io.write("Model listing cancelled.");
          else options.io.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
          continue;
        } finally {
          if (activeController === listController) activeController = undefined;
        }
        try {
          let selection: string | null;
          const picker = options.io.select;
          const usesPicker = picker !== undefined;
          if (picker) {
            selection = await picker.call(options.io, {
              title: "Select model",
              items: models.map((model) => ({
                value: qualifiedModels ? `${(model as ReplQualifiedModel).provider}/${model.id}` : model.id,
                label: qualifiedModels ? `${(model as ReplQualifiedModel).provider}/${model.id}` : model.id,
                ...(model.ownedBy ? { description: model.ownedBy } : {}),
              })),
              selectedValue: qualifiedModels
                ? `${modelManager.currentProvider ?? "agnes"}/${modelManager.currentModel}`
                : modelManager.currentModel,
            });
          } else {
            options.io.write(`Available models · current: ${modelManager.currentModel}`);
            models.forEach((model, index) => {
              const value = qualifiedModels ? `${(model as ReplQualifiedModel).provider}/${model.id}` : model.id;
              const current = value === (qualifiedModels
                ? `${modelManager.currentProvider ?? "agnes"}/${modelManager.currentModel}`
                : modelManager.currentModel)
                ? " *"
                : "";
              options.io.write(`${index + 1}. ${value}${current}`);
            });
            selection = await options.io.read("model> ");
          }
          if (selection === null) {
            if (!options.io.select) exitRequested = true;
            continue;
          }
          const value = selection.trim();
          if (value.length === 0) {
            options.io.write("Model selection cancelled.");
            continue;
          }
          const selected = qualifiedModels
            ? (/^[1-9]\d*$/.test(value)
              ? qualifiedModels[Number(value) - 1]
              : qualifiedModels.find((model) => `${model.provider}/${model.id}` === value))
            : undefined;
          const selectedId = selected?.id ?? (qualifiedModels ? undefined : options.io.select
            ? models.find((model) => model.id === value)?.id
            : resolveModelSelection(value, models));
          if (!selectedId || (qualifiedModels && !selected)) {
            options.io.error(`Invalid model selection: ${value}`);
            continue;
          }
          if (qualifiedModels && modelManager.selectQualifiedModel && selected) {
            await modelManager.selectQualifiedModel(selected.provider, selectedId);
            options.onModelChanged?.(selectedId);
            if (!usesPicker) options.io.write(`Switched model to ${selected.provider}/${selectedId}.`);
          } else {
            await modelManager.selectModel(selectedId);
            options.onModelChanged?.(selectedId);
            if (!usesPicker) options.io.write(`Switched model to ${selectedId}.`);
          }
        } catch (error) {
          options.io.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (task === "/provider" || task.startsWith("/provider ")) {
        const providerManager = options.models;
        const providers = providerManager?.availableProviders?.() ?? [];
        if (!providerManager?.selectProvider || providers.length === 0) {
          options.io.error("Provider switching is unavailable.");
          continue;
        }
        const requested = task.slice("/provider".length).trim();
        if (!requested) {
          options.io.write(`Providers · current: ${providerManager.currentProvider ?? "unknown"}`);
          providers.forEach((provider) => options.io.write(`${provider}${provider === providerManager.currentProvider ? " *" : ""}`));
          continue;
        }
        if (!providers.includes(requested as AgentProvider)) {
          options.io.error(`Provider '${requested}' is not configured.`);
          continue;
        }
        try {
          await providerManager.selectProvider(requested as AgentProvider);
          options.onModelChanged?.(providerManager.currentModel);
          options.io.write(`Switched provider to ${requested} · model: ${providerManager.currentModel}.`);
        } catch (error) {
          options.io.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
        }
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
      const invocation = await options.skills?.parseInvocation(task);
      if (invocation) {
        pendingTask = invocation.prompt;
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

export function resolveModelSelection(
  selection: string,
  models: readonly ModelCatalogEntry[],
): string | undefined {
  if (/^[1-9]\d*$/.test(selection)) return models[Number(selection) - 1]?.id;
  return models.find((model) => model.id === selection)?.id;
}

function formatUsage(usage: RunUsage): string {
  return `${usage.inputTokens} input · ${usage.outputTokens} output · ${usage.totalTokens} total tokens · ${usage.modelRequests} request(s) · ${usage.modelDurationMs}ms`;
}
