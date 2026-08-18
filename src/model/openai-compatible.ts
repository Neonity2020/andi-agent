import type {
  AssistantTurn,
  CompletionOptions,
  Message,
  ModelProvider,
  ModelToolDefinition,
  TokenUsage,
  ToolCall,
} from "./types";
import { throwIfAborted } from "../runtime/abort";

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

interface ApiToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface ApiToolCallDelta extends ApiToolCall {
  index?: unknown;
}

function parseToolCall(value: ApiToolCall): ToolCall {
  if (
    typeof value.id !== "string" ||
    typeof value.function?.name !== "string" ||
    typeof value.function.arguments !== "string"
  ) {
    throw new Error("Model returned a malformed tool call");
  }
  return { id: value.id, name: value.function.name, arguments: value.function.arguments };
}

function toApiMessage(message: Message): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return message;
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

async function parseStreamingResponse(
  response: Response,
  onTextDelta: NonNullable<CompletionOptions["onTextDelta"]>,
  signal?: AbortSignal,
): Promise<AssistantTurn> {
  if (!response.body) throw new Error("Streaming model response did not contain a body");
  throwIfAborted(signal);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let buffer = "";
  let content = "";
  let usage: TokenUsage | undefined;
  const abortReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortReader, { once: true });

  const processEvent = async (event: string): Promise<boolean> => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) return false;
    if (data.trim() === "[DONE]") return true;

    const payload = JSON.parse(data) as {
      error?: { message?: unknown };
      choices?: Array<{ delta?: { content?: unknown; tool_calls?: ApiToolCallDelta[] } }>;
      usage?: unknown;
    };
    if (payload.error) {
      throw new Error(
        `Streaming model error: ${typeof payload.error.message === "string" ? payload.error.message : data}`,
      );
    }
    usage = parseUsage(payload.usage) ?? usage;
    const delta = payload.choices?.[0]?.delta;
    if (!delta) return false;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      await onTextDelta(delta.content);
    }

    for (const call of delta.tool_calls ?? []) {
      if (!Number.isInteger(call.index)) throw new Error("Streaming tool call is missing a numeric index");
      const index = call.index as number;
      const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof call.id === "string") current.id += call.id;
      if (typeof call.function?.name === "string") current.name += call.function.name;
      if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments;
      toolCalls.set(index, current);
    }
    return false;
  };

  try {
    let done = false;
    while (!done) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (await processEvent(event)) {
          done = true;
          break;
        }
      }
      if (chunk.done) {
        if (buffer.trim().length > 0) await processEvent(buffer);
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
  }

  const orderedCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => parseToolCall({ id: call.id, function: { name: call.name, arguments: call.arguments } }));
  return {
    content: content.length > 0 ? content : null,
    toolCalls: orderedCalls,
    ...(usage ? { usage } : {}),
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetcher: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    if (options.apiKey.length === 0) throw new Error("apiKey is required");
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = (options.baseUrl ?? "https://apihub.agnes-ai.com/v1").replace(/\/$/, "");
    this.#fetcher = options.fetcher ?? fetch;
  }

  async complete(
    messages: readonly Message[],
    tools: readonly ModelToolDefinition[],
    options?: CompletionOptions,
  ): Promise<AssistantTurn> {
    const streaming = options?.onTextDelta !== undefined;
    throwIfAborted(options?.signal);
    const response = await this.#fetcher(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        messages: messages.map(toApiMessage),
        tools: tools.map((tool) => ({ type: "function", function: tool })),
        tool_choice: "auto",
        stream: streaming,
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`Model request failed (${response.status}): ${detail}`);
    }

    if (options?.onTextDelta) return parseStreamingResponse(response, options.onTextDelta, options.signal);

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; tool_calls?: ApiToolCall[] } }>;
      usage?: unknown;
    };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("Model response did not contain a message");
    if (message.content !== null && message.content !== undefined && typeof message.content !== "string") {
      throw new Error("Model returned malformed content");
    }

    const usage = parseUsage(payload.usage);
    return {
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map(parseToolCall),
      ...(usage ? { usage } : {}),
    };
  }
}
