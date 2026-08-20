import type { ModelToolDefinition } from "../model/types";
import type { Tool, ToolExecutionResult } from "./types";
import type { ToolExecutionContext } from "./types";
import { isCancellationError, throwIfAborted } from "../runtime/abort";

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  definitions(): ModelToolDefinition[] {
    return [...this.#tools.values()].sort((left, right) => left.name.localeCompare(right.name)).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async execute(
    name: string,
    rawArguments: string,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    throwIfAborted(context.signal);
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

    let input: unknown;
    try {
      input = JSON.parse(rawArguments) as unknown;
    } catch {
      return { ok: false, error: `Invalid JSON arguments for tool ${name}` };
    }

    try {
      return { ok: true, value: await tool.execute(input, context) };
    } catch (error) {
      if (isCancellationError(error)) throw error;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
