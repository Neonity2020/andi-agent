export type JsonSchema = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunUsage extends TokenUsage {
  modelRequests: number;
  modelDurationMs: number;
}

export interface CompletionOptions {
  onTextDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  complete(
    messages: readonly Message[],
    tools: readonly ModelToolDefinition[],
    options?: CompletionOptions,
  ): Promise<AssistantTurn>;
}
