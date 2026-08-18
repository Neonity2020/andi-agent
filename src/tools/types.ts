import type { ModelToolDefinition } from "../model/types";

export interface Tool extends ModelToolDefinition {
  execute(input: unknown, context?: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export type ToolExecutionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };
