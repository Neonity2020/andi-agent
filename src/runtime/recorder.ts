import type { AgentEvent } from "../agent";
import type { Workspace } from "../tools/workspace";

export class RunRecorder {
  readonly #workspace: Workspace;
  readonly #lines = new Map<string, string[]>();

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async record(event: AgentEvent): Promise<void> {
    if (event.type === "model_text_delta") return;
    const lines = this.#lines.get(event.runId) ?? [];
    lines.push(JSON.stringify({ timestamp: new Date().toISOString(), ...sanitizeEvent(event) }));
    this.#lines.set(event.runId, lines);
    await this.#workspace.write(`.andi-agent/runs/${event.runId}.jsonl`, `${lines.join("\n")}\n`);
    if (event.type === "agent_completed" || event.type === "agent_cancelled" || event.type === "agent_failed") {
      this.#lines.delete(event.runId);
    }
  }
}

function sanitizeEvent(event: Exclude<AgentEvent, { type: "model_text_delta" }>): Record<string, unknown> {
  if (event.type === "agent_failed" || event.type === "memory_context_failed") {
    return { ...event, error: redact(event.error).slice(0, 300) };
  }
  return event;
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key[=:]\s*)\S+/gi, "$1[REDACTED]");
}
