import type { ModelToolDefinition } from "../model/types";

export interface Tool extends ModelToolDefinition {
  execute(input: unknown): Promise<unknown>;
}

export type ToolExecutionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };
