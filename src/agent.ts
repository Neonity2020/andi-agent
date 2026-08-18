import type { Message, ModelProvider } from "./model/types";
import { ToolRegistry } from "./tools/registry";
import { compactMessages } from "./context";

export type AgentEvent =
  | { type: "turn_started"; turn: number; messageCount: number }
  | { type: "model_completed"; turn: number; toolCallCount: number }
  | { type: "model_text_delta"; turn: number; delta: string }
  | { type: "tool_started"; turn: number; toolCallId: string; toolName: string }
  | { type: "tool_completed"; turn: number; toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: "context_compacted"; droppedMessages: number; remainingMessages: number }
  | { type: "agent_completed"; turns: number };

export interface AgentRunResult {
  output: string;
  messages: Message[];
}

export interface AgentOptions {
  model: ModelProvider;
  tools: ToolRegistry;
  systemPrompt?: string;
  maxTurns?: number;
  maxContextChars?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT = `You are a coding agent working inside a constrained workspace.
Use search_code and read_file to inspect existing code before changing it. Prefer edit_file for precise changes and write_file for new files.
Make the smallest coherent change that completes the task. Run the relevant available verification command after editing.
Review git_diff before staging. Only stage or commit when the user explicitly asks for it and approves the command.
Never claim that a check passed unless its tool result confirms it. Explain the completed result concisely.`;

export class Agent {
  readonly #model: ModelProvider;
  readonly #tools: ToolRegistry;
  readonly #systemPrompt: string;
  readonly #maxTurns: number;
  readonly #maxContextChars: number;
  readonly #onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined;

  constructor(options: AgentOptions) {
    this.#model = options.model;
    this.#tools = options.tools;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#maxTurns = options.maxTurns ?? 12;
    this.#maxContextChars = options.maxContextChars ?? 120_000;
    this.#onEvent = options.onEvent;
    if (!Number.isInteger(this.#maxTurns) || this.#maxTurns < 1) {
      throw new Error("maxTurns must be a positive integer");
    }
    if (!Number.isInteger(this.#maxContextChars) || this.#maxContextChars < 1) {
      throw new Error("maxContextChars must be a positive integer");
    }
  }

  async run(task: string): Promise<string> {
    return (await this.runWithHistory(task)).output;
  }

  async runWithHistory(task: string, history: readonly Message[] = []): Promise<AgentRunResult> {
    if (task.trim().length === 0) throw new Error("Task cannot be empty");

    let messages: Message[] = history.length > 0 ? [...history] : [{ role: "system", content: this.#systemPrompt }];
    if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: this.#systemPrompt });
    messages.push({ role: "user", content: task });
    const definitions = this.#tools.definitions();

    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      const compacted = compactMessages(messages, this.#maxContextChars);
      messages = compacted.messages;
      if (compacted.droppedMessages > 0) {
        await this.#emit({
          type: "context_compacted",
          droppedMessages: compacted.droppedMessages,
          remainingMessages: messages.length,
        });
      }

      await this.#emit({ type: "turn_started", turn, messageCount: messages.length });
      const response = await this.#model.complete(messages, definitions, {
        onTextDelta: (delta) => this.#emit({ type: "model_text_delta", turn, delta }),
      });
      await this.#emit({ type: "model_completed", turn, toolCallCount: response.toolCalls.length });
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      if (response.toolCalls.length === 0) {
        await this.#emit({ type: "agent_completed", turns: turn });
        return { output: response.content ?? "", messages };
      }

      for (const call of response.toolCalls) {
        await this.#emit({
          type: "tool_started",
          turn,
          toolCallId: call.id,
          toolName: call.name,
        });
        const startedAt = performance.now();
        const result = await this.#tools.execute(call.name, call.arguments);
        await this.#emit({
          type: "tool_completed",
          turn,
          toolCallId: call.id,
          toolName: call.name,
          ok: result.ok,
          durationMs: Math.round(performance.now() - startedAt),
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(result),
        });
      }
    }

    throw new Error(`Agent reached the maximum of ${this.#maxTurns} turns`);
  }

  async #emit(event: AgentEvent): Promise<void> {
    await this.#onEvent?.(event);
  }
}
