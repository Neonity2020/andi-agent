import { rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message, ToolCall } from "./model/types";
import type { Workspace } from "./tools/workspace";

interface StoredSession {
  version: 1;
  id: string;
  updatedAt: string;
  messages: Message[];
}

export class SessionStore {
  readonly #workspace: Workspace;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async load(id: string): Promise<Message[]> {
    validateSessionId(id);
    let content: string;
    try {
      content = await this.#workspace.read(sessionPath(id));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new Error(`Session '${id}' contains invalid JSON`);
    }
    if (!isStoredSession(value) || value.id !== id) throw new Error(`Session '${id}' has an invalid format`);
    return value.messages;
  }

  async save(id: string, messages: readonly Message[]): Promise<void> {
    validateSessionId(id);
    const target = sessionPath(id);
    const temporary = `.andi-agent/sessions/.${id}.${randomUUID()}.tmp`;
    const value: StoredSession = {
      version: 1,
      id,
      updatedAt: new Date().toISOString(),
      messages: [...messages],
    };
    await this.#workspace.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(join(this.#workspace.root, temporary), join(this.#workspace.root, target));
  }
}

export function validateSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error("Session ID must use 1-64 letters, numbers, underscores, or hyphens");
  }
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

function isStoredSession(value: unknown): value is StoredSession {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
