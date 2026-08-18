import { Agent, type AgentEvent } from "../agent";
import type { AgentConfig } from "../config";
import { OpenAICompatibleProvider } from "../model/openai-compatible";
import type { ModelProvider } from "../model/types";
import { RunRecorder } from "../runtime/recorder";
import { SessionStore } from "../session";
import { createCommandTool } from "../tools/command";
import { createEditTool } from "../tools/editing";
import { createGitTools } from "../tools/git";
import { ToolRegistry } from "../tools/registry";
import { createSearchTool } from "../tools/search";
import { createWorkspaceTools, type Workspace } from "../tools/workspace";
import { createWebSearchTool } from "../tools/web-search";
import { addRunUsage } from "../usage";
import type { ScheduledTaskRunner } from "./types";

export interface ScheduledAgentRunnerOptions {
  workspace: Workspace;
  config: AgentConfig;
  model?: ModelProvider;
  onEvent?: (taskId: string, event: AgentEvent) => void | Promise<void>;
  onResult?: (taskId: string, output: string) => void;
}

export function createScheduledAgentRunner(options: ScheduledAgentRunnerOptions): ScheduledTaskRunner {
  const model = options.model ?? new OpenAICompatibleProvider(options.config);
  const tools = new ToolRegistry([
    ...createWorkspaceTools(options.workspace),
    createEditTool(options.workspace),
    createSearchTool(options.workspace.root),
    createCommandTool(options.workspace.root),
    ...createGitTools(options.workspace),
    ...(options.config.exa ? [createWebSearchTool(options.config.exa)] : []),
  ]);
  const sessions = new SessionStore(options.workspace);
  const recorder = new RunRecorder(options.workspace);

  return async (scheduledTask, signal) => {
    const snapshot = await sessions.loadSnapshot(scheduledTask.sessionId);
    let runId: string | undefined;
    const agent = new Agent({
      model,
      tools,
      maxTurns: options.config.maxTurns,
      maxContextChars: options.config.maxContextChars,
      async onEvent(event) {
        runId = event.runId;
        await recorder.record(event);
        await options.onEvent?.(scheduledTask.id, event);
      },
    });
    try {
      const result = await agent.runWithHistory(scheduledTask.task, snapshot.messages, {
        ...(signal ? { signal } : {}),
        onCheckpoint: (checkpoint) =>
          sessions.saveCheckpoint(
            scheduledTask.sessionId,
            checkpoint,
            addRunUsage(snapshot.usage, checkpoint.usage),
          ),
      });
      options.onResult?.(scheduledTask.id, result.output);
      return { runId: result.runId, output: result.output };
    } catch (error) {
      if (runId && error instanceof Error) {
        try {
          Object.defineProperty(error, "runId", { value: runId, configurable: true });
        } catch {
          // Preserve the original model or cancellation error if it is not extensible.
        }
      }
      throw error;
    }
  };
}
