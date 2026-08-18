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
}

export interface CompletionOptions {
  onTextDelta?: (delta: string) => void | Promise<void>;
}

export interface ModelProvider {
  complete(
    messages: readonly Message[],
    tools: readonly ModelToolDefinition[],
    options?: CompletionOptions,
  ): Promise<AssistantTurn>;
}
