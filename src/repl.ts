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

export interface ReplCommand {
  name: string;
  description: string;
}

// Single source of truth for slash commands: /help output and the TUI's
// inline completion list both derive from it.
export const REPL_COMMANDS: readonly ReplCommand[] = [
  { name: "/help", description: "显示 REPL 命令" },
  { name: "/status", description: "显示会话、运行和历史状态" },
  { name: "/usage", description: "显示 Token 和模型耗时统计" },
  { name: "/recover", description: "修复不完整的工具调用历史" },
  { name: "/new", description: "开启新对话" },
  { name: "/clear", description: "清空内存和持久化对话历史" },
  { name: "/memory", description: "列出工作区长期记忆" },
  { name: "/memory search", description: "搜索工作区长期记忆" },
  { name: "/memory show", description: "查看一条工作区长期记忆" },
  { name: "/models", description: "选择已缓存的 Chat Completions 模型" },
  { name: "/models refresh", description: "刷新当前 Provider 的模型目录" },
  { name: "/provider", description: "查看或切换模型 Provider" },
  { name: "/skills", description: "列出已发现的技能" },
  { name: "/exit", description: "退出 REPL" },
];

const REPL_HELP = `${REPL_COMMANDS.map((command) => `${command.name.padEnd(24)}${command.description}`).join("\n")}
/<skill-name> [参数]      显式调用技能
Ctrl-D                    在任何 TUI 状态下立即退出`;

export async function runRepl(options: ReplOptions): Promise<Message[]> {
  let history = [...(options.initialHistory ?? [])];
  let sessionUsage = { ...(options.initialUsage ?? emptyRunUsage()) };
  let lastRunUsage = emptyRunUsage();
  let pendingTask = options.initialTask?.trim() || undefined;
  let activeController: AbortController | undefined;
  let activeRunId: string | undefined;
  let exitRequested = false;
  options.io.write(`andi-agent REPL · 会话：${options.sessionId ?? "仅内存"}`);
  options.io.write("输入 /help 查看命令。");

  options.io.onInterrupt?.(() => {
    if (activeController && !activeController.signal.aborted) {
      options.io.error("正在取消当前轮次……");
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
      options.io.error(`[错误] 保存会话失败：${error instanceof Error ? error.message : String(error)}`);
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
          `会话：${options.sessionId ?? "仅内存"} · 模型：${options.models?.currentProvider ? `${options.models.currentProvider}/` : ""}${options.models?.currentModel ?? "未知"} · 状态：${activeController ? "运行中" : "空闲"} · 消息：${history.length}`,
        );
        continue;
      }
      if (task === "/usage") {
        options.io.write(`最近一轮：${formatUsage(lastRunUsage)}`);
        options.io.write(`当前会话：${formatUsage(sessionUsage)}`);
        continue;
      }
      if (task === "/recover") {
        const repaired = repairIncompleteToolCalls(history);
        history = repaired.messages;
        await persistHistory();
        options.io.write(`恢复完成 · 修复了 ${repaired.repairedToolResults} 个缺失的工具结果。`);
        continue;
      }
      if (task === "/new" || task === "/clear") {
        history = [];
        sessionUsage = emptyRunUsage();
        lastRunUsage = emptyRunUsage();
        await persistHistory();
        options.io.write(task === "/new" ? "新对话已开始。" : "对话历史已清空。");
        continue;
      }
      if (task === "/skills") {
        if (!options.skills) {
          options.io.error("技能不可用。");
          continue;
        }
        const skills = options.skills.list();
        if (skills.length === 0) options.io.write("未发现任何技能。");
        else {
          for (const skill of skills) {
            const invocation = skill.userInvocable ? `/${skill.name}` : "（仅模型可调用）";
            options.io.write(`${invocation}\t${skill.description} · 来源：${skill.source === "project" ? "项目" : "用户"}`);
          }
        }
        for (const issue of options.skills.issues?.() ?? []) {
          options.io.error(`[skill] skipped ${issue.path}: ${issue.error}`);
        }
        continue;
      }
      if (task === "/models" || task === "/models refresh") {
        if (!options.models) {
          options.io.error("模型切换不可用。");
          continue;
        }
        const modelManager = options.models;
        const refresh = task === "/models refresh";
        const refreshModels = modelManager.refreshModels;
        if (refresh && !refreshModels) {
          options.io.error("模型目录刷新不可用。");
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
            if (isCancellationError(error)) options.io.write("模型列表加载已取消。");
            else options.io.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
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
              title: "选择模型",
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
            options.io.write(`可用模型 · 当前：${modelManager.currentModel}`);
            models.forEach((model, index) => {
              const value = qualifiedModels ? `${(model as ReplQualifiedModel).provider}/${model.id}` : model.id;
              const current = value === (qualifiedModels
                ? `${modelManager.currentProvider ?? "agnes"}/${modelManager.currentModel}`
                : modelManager.currentModel)
                ? " *"
                : "";
              options.io.write(`${index + 1}. ${value}${current}`);
            });
             selection = await options.io.read("模型> ");
          }
          if (selection === null) {
            if (!options.io.select) exitRequested = true;
            continue;
          }
          const value = selection.trim();
          if (value.length === 0) {
            options.io.write("已取消模型选择。");
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
            options.io.error(`无效的模型选择：${value}`);
            continue;
          }
          if (qualifiedModels && modelManager.selectQualifiedModel && selected) {
            await modelManager.selectQualifiedModel(selected.provider, selectedId);
            options.onModelChanged?.(selectedId);
            if (!usesPicker) options.io.write(`已切换模型：${selected.provider}/${selectedId}。`);
          } else {
            await modelManager.selectModel(selectedId);
            options.onModelChanged?.(selectedId);
            if (!usesPicker) options.io.write(`已切换模型：${selectedId}。`);
          }
        } catch (error) {
          options.io.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (task === "/provider" || task.startsWith("/provider ")) {
        const providerManager = options.models;
        const providers = providerManager?.availableProviders?.() ?? [];
        if (!providerManager?.selectProvider || providers.length === 0) {
          options.io.error("Provider 切换不可用。");
          continue;
        }
        const requested = task.slice("/provider".length).trim();
        if (!requested) {
          options.io.write(`Provider · 当前：${providerManager.currentProvider ?? "未知"}`);
          providers.forEach((provider) => options.io.write(`${provider}${provider === providerManager.currentProvider ? " *" : ""}`));
          continue;
        }
        if (!providers.includes(requested as AgentProvider)) {
          options.io.error(`Provider“${requested}”未配置。`);
          continue;
        }
        try {
          await providerManager.selectProvider(requested as AgentProvider);
          options.onModelChanged?.(providerManager.currentModel);
          options.io.write(`已切换 Provider：${requested} · 模型：${providerManager.currentModel}。`);
        } catch (error) {
          options.io.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (task === "/memory" || task === "/memory list") {
        if (!options.memory) {
          options.io.error("长期记忆不可用。");
          continue;
        }
        try {
          const memories = await options.memory.list();
          if (memories.length === 0) options.io.write("暂无长期记忆。");
          else {
            for (const memory of memories) {
              options.io.write(`${memory.id}\t${memory.title}\t${memory.tags.join(", ") || "no tags"}`);
            }
          }
        } catch (error) {
          options.io.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (task.startsWith("/memory search ")) {
        if (!options.memory) {
          options.io.error("长期记忆不可用。");
          continue;
        }
        try {
          const query = task.slice("/memory search ".length).trim();
          const matches = await options.memory.search(query, 10);
          if (matches.length === 0) options.io.write("没有匹配的记忆。");
          else {
            for (const match of matches) {
              options.io.write(`${match.id}\t${match.score.toFixed(2)}\t${match.title}\n${match.snippet}`);
            }
          }
        } catch (error) {
          options.io.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (task.startsWith("/memory show ")) {
        if (!options.memory) {
          options.io.error("长期记忆不可用。");
          continue;
        }
        try {
          const memory = await options.memory.read(task.slice("/memory show ".length).trim());
          options.io.write(`# ${memory.title}\n\n${memory.content}`);
        } catch (error) {
          options.io.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      const invocation = await options.skills?.parseInvocation(task);
      if (invocation) {
        pendingTask = invocation.prompt;
        continue;
      }
      options.io.error(`未知 REPL 命令：${task}。输入 /help 查看命令。`);
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
              `[错误] 保存检查点失败：${error instanceof Error ? error.message : String(error)}`,
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
      if (isCancellationError(error)) options.io.write("当前轮次已取消。");
      else options.io.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeController = undefined;
      activeRunId = undefined;
    }
  }

  options.io.write("REPL 已关闭。");
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
  const cache = usage.cachedInputTokens ? ` · 缓存命中 ${usage.cachedInputTokens} Token` : "";
  return `${usage.inputTokens} 输入 · ${usage.outputTokens} 输出 · ${usage.totalTokens} 总 Token · ${usage.modelRequests} 次请求 · ${usage.modelDurationMs}ms${cache}`;
}
