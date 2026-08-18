import { rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentCheckpoint, AgentCheckpointState } from "./agent";
import type { Message, RunUsage, ToolCall } from "./model/types";
import type { Workspace } from "./tools/workspace";
import { emptyRunUsage } from "./usage";

interface StoredSessionV1 {
  version: 1;
  id: string;
  updatedAt: string;
  messages: Message[];
}

interface StoredSessionV2 {
  version: 2;
  id: string;
  state: AgentCheckpointState;
  activeRunId?: string;
  updatedAt: string;
  messages: Message[];
  usage: RunUsage;
}

export interface SessionSnapshot {
  state: AgentCheckpointState;
  activeRunId: string | undefined;
  updatedAt: string | undefined;
  messages: Message[];
  usage: RunUsage;
}

export interface RepairResult {
  messages: Message[];
  repairedToolResults: number;
}

const RECOVERY_NOTE =
  "[The previous agent run was interrupted. Missing tool results were marked as failed. Re-read workspace and Git state before continuing.]";

export class SessionStore {
  readonly #workspace: Workspace;
  readonly #writeQueues = new Map<string, Promise<void>>();

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async load(id: string): Promise<Message[]> {
    return (await this.loadSnapshot(id)).messages;
  }

  async loadSnapshot(id: string): Promise<SessionSnapshot> {
    validateSessionId(id);
    let content: string;
    try {
      content = await this.#workspace.read(sessionPath(id));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptySnapshot();
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new Error(`Session '${id}' contains invalid JSON`);
    }

    if (isStoredSessionV1(value) && value.id === id) {
      const migrated: SessionSnapshot = {
        state: "idle",
        activeRunId: undefined,
        updatedAt: value.updatedAt,
        messages: value.messages,
        usage: emptyRunUsage(),
      };
      await this.saveSnapshot(id, migrated);
      return migrated;
    }
    if (!isStoredSessionV2(value) || value.id !== id) throw new Error(`Session '${id}' has an invalid format`);

    const snapshot: SessionSnapshot = {
      state: value.state,
      activeRunId: value.activeRunId,
      updatedAt: value.updatedAt,
      messages: value.messages,
      usage: value.usage,
    };
    if (snapshot.state === "idle") return snapshot;

    const repaired = repairIncompleteToolCalls(snapshot.messages);
    if (!repaired.messages.some((message) => message.role === "system" && message.content === RECOVERY_NOTE)) {
      repaired.messages.push({ role: "system", content: RECOVERY_NOTE });
    }
    const recovered: SessionSnapshot = {
      state: "idle",
      activeRunId: undefined,
      updatedAt: new Date().toISOString(),
      messages: repaired.messages,
      usage: snapshot.usage,
    };
    await this.saveSnapshot(id, recovered);
    return recovered;
  }

  async save(id: string, messages: readonly Message[]): Promise<void> {
    await this.saveSnapshot(id, {
      state: "idle",
      activeRunId: undefined,
      updatedAt: new Date().toISOString(),
      messages: [...messages],
      usage: emptyRunUsage(),
    });
  }

  async saveCheckpoint(id: string, checkpoint: AgentCheckpoint, totalUsage: RunUsage): Promise<void> {
    await this.saveSnapshot(id, {
      state: checkpoint.state,
      activeRunId: checkpoint.state === "idle" ? undefined : checkpoint.runId,
      updatedAt: new Date().toISOString(),
      messages: checkpoint.messages,
      usage: totalUsage,
    });
  }

  async saveSnapshot(id: string, snapshot: SessionSnapshot): Promise<void> {
    validateSessionId(id);
    const previous = this.#writeQueues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#writeSnapshot(id, snapshot));
    this.#writeQueues.set(id, next);
    try {
      await next;
    } finally {
      if (this.#writeQueues.get(id) === next) this.#writeQueues.delete(id);
    }
  }

  async #writeSnapshot(id: string, snapshot: SessionSnapshot): Promise<void> {
    const target = sessionPath(id);
    const temporary = `.andi-agent/sessions/.${id}.${randomUUID()}.tmp`;
    const value: StoredSessionV2 = {
      version: 2,
      id,
      state: snapshot.state,
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
      messages: [...snapshot.messages],
      usage: { ...snapshot.usage },
    };
    await this.#workspace.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(join(this.#workspace.root, temporary), join(this.#workspace.root, target));
  }
}

export function repairIncompleteToolCalls(messages: readonly Message[]): RepairResult {
  const repaired: Message[] = [];
  let repairedToolResults = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Message;
    repaired.push(message);
    if (message.role !== "assistant" || message.toolCalls.length === 0) continue;

    const followingTools: Array<Extract<Message, { role: "tool" }>> = [];
    while (messages[index + 1]?.role === "tool") {
      followingTools.push(messages[index + 1] as Extract<Message, { role: "tool" }>);
      index += 1;
    }
    repaired.push(...followingTools);
    const existingIds = new Set(followingTools.map((tool) => tool.toolCallId));
    for (const call of message.toolCalls) {
      if (existingIds.has(call.id)) continue;
      repaired.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify({ ok: false, error: "Tool result unavailable because the previous run was interrupted" }),
      });
      repairedToolResults += 1;
    }
  }

  return { messages: repaired, repairedToolResults };
}

export function validateSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error("Session ID must use 1-64 letters, numbers, underscores, or hyphens");
  }
}

function emptySnapshot(): SessionSnapshot {
  return {
    state: "idle",
    activeRunId: undefined,
    updatedAt: undefined,
    messages: [],
    usage: emptyRunUsage(),
  };
}

function sessionPath(id: string): string {
  return `.andi-agent/sessions/${id}.json`;
}

function isToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.name === "string" && typeof value.arguments === "string";
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value) || typeof value.role !== "string") return false;
  if (value.role === "system" || value.role === "user") return typeof value.content === "string";
  if (value.role === "assistant") {
    return (
      (typeof value.content === "string" || value.content === null) &&
      Array.isArray(value.toolCalls) &&
      value.toolCalls.every(isToolCall)
    );
  }
  return (
    value.role === "tool" &&
    typeof value.toolCallId === "string" &&
    typeof value.name === "string" &&
    typeof value.content === "string"
  );
}

function isRunUsage(value: unknown): value is RunUsage {
  if (!isRecord(value)) return false;
  return ["inputTokens", "outputTokens", "totalTokens", "modelRequests", "modelDurationMs"].every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
  );
}

function isStoredSessionV1(value: unknown): value is StoredSessionV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage)
  );
}

function isStoredSessionV2(value: unknown): value is StoredSessionV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    typeof value.id === "string" &&
    (value.state === "idle" || value.state === "running" || value.state === "cancelled" || value.state === "failed") &&
    (value.activeRunId === undefined || typeof value.activeRunId === "string") &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage) &&
    isRunUsage(value.usage)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
