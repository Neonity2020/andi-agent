import { createHash, randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "../tools/workspace";
import { validateScheduledTaskId } from "./parser";
import type { ScheduleRegistry, ScheduledRun, ScheduledTask, ScheduledTaskInput } from "./types";

const REGISTRY_PATH = ".andi-agent/schedules.json";
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;

export class ScheduleStore {
  readonly #workspace: Workspace;
  #queue: Promise<void> = Promise.resolve();

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async list(): Promise<ScheduledTask[]> {
    await this.#queue.catch(() => undefined);
    return (await this.#read()).map(cloneTask);
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    validateScheduledTaskId(id);
    return (await this.list()).find((task) => task.id === id);
  }

  async add(input: ScheduledTaskInput, now = new Date()): Promise<ScheduledTask> {
    validateScheduledTaskId(input.id);
    if (input.sessionId) validateScheduledTaskId(input.sessionId);
    if (input.task.trim().length === 0) throw new Error("Scheduled task text cannot be empty");
    const task: ScheduledTask = {
      id: input.id,
      task: input.task.trim(),
      schedule: input.schedule,
      sessionId: input.sessionId ?? defaultSessionId(input.id),
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt:
        input.schedule.kind === "once"
          ? input.schedule.at
          : new Date(now.getTime() + input.schedule.everyMs).toISOString(),
    };
    if (!isScheduledTask(task)) throw new Error("Scheduled task has an invalid format");
    await this.#mutate((tasks) => {
      if (tasks.some((existing) => existing.id === task.id)) {
        throw new Error(`Scheduled task '${task.id}' already exists`);
      }
      tasks.push(task);
    });
    return cloneTask(task);
  }

  async remove(id: string): Promise<boolean> {
    validateScheduledTaskId(id);
    let removed = false;
    await this.#mutate((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index !== -1) {
        tasks.splice(index, 1);
        removed = true;
      }
    });
    return removed;
  }

  async replace(task: ScheduledTask): Promise<void> {
    if (!isScheduledTask(task)) throw new Error("Scheduled task has an invalid format");
    await this.#mutate((tasks) => {
      const index = tasks.findIndex((existing) => existing.id === task.id);
      if (index === -1) throw new Error(`Scheduled task '${task.id}' does not exist`);
      tasks[index] = cloneTask(task);
    });
  }

  async recoverInterrupted(now = new Date()): Promise<number> {
    let recovered = 0;
    await this.#mutate((tasks) => {
      for (const task of tasks) {
        if (task.lastRun?.status !== "running") continue;
        task.lastRun = {
          ...task.lastRun,
          status: "failed",
          finishedAt: now.toISOString(),
          error: "Scheduler stopped before the run completed",
        };
        recovered += 1;
      }
    }, false);
    return recovered;
  }

  async #mutate(mutator: (tasks: ScheduledTask[]) => void, writeWhenUnchanged = true): Promise<void> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      const tasks = await this.#read();
      const before = JSON.stringify(tasks);
      mutator(tasks);
      if (writeWhenUnchanged || JSON.stringify(tasks) !== before) await this.#write(tasks);
    });
    this.#queue = operation;
    await operation;
  }

  async #read(): Promise<ScheduledTask[]> {
    let content: string;
    try {
      content = await this.#workspace.read(REGISTRY_PATH);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new Error("Scheduled task registry contains invalid JSON");
    }
    if (!isScheduleRegistry(value)) throw new Error("Scheduled task registry has an invalid format");
    return value.tasks.map(cloneTask);
  }

  async #write(tasks: ScheduledTask[]): Promise<void> {
    const temporary = `.andi-agent/.schedules.${randomUUID()}.tmp`;
    const registry: ScheduleRegistry = { version: 1, tasks };
    await this.#workspace.write(temporary, `${JSON.stringify(registry, null, 2)}\n`);
    await rename(join(this.#workspace.root, temporary), join(this.#workspace.root, REGISTRY_PATH));
  }
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return structuredClone(task);
}

function defaultSessionId(id: string): string {
  const readable = `schedule-${id}`;
  if (readable.length <= 64) return readable;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `schedule-${id.slice(0, 38)}-${digest}`;
}

function isScheduleRegistry(value: unknown): value is ScheduleRegistry {
  return isRecord(value) && value.version === 1 && Array.isArray(value.tasks) && value.tasks.every(isScheduledTask);
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!isRecord(value)) return false;
  try {
    if (typeof value.id !== "string") return false;
    validateScheduledTaskId(value.id);
    if (typeof value.sessionId !== "string") return false;
    validateScheduledTaskId(value.sessionId);
  } catch {
    return false;
  }
  return (
    typeof value.task === "string" &&
    value.task.trim().length > 0 &&
    typeof value.enabled === "boolean" &&
    isIsoDate(value.createdAt) &&
    (value.nextRunAt === undefined || isIsoDate(value.nextRunAt)) &&
    isSchedule(value.schedule) &&
    (value.lastRun === undefined || isScheduledRun(value.lastRun))
  );
}

function isSchedule(value: unknown): boolean {
  return (
    isRecord(value) &&
    ((value.kind === "once" && isIsoDate(value.at)) ||
      (value.kind === "interval" &&
        typeof value.everyMs === "number" &&
        Number.isSafeInteger(value.everyMs) &&
        value.everyMs >= MIN_INTERVAL_MS &&
        value.everyMs <= MAX_INTERVAL_MS))
  );
}

function isScheduledRun(value: unknown): value is ScheduledRun {
  return (
    isRecord(value) &&
    isIsoDate(value.startedAt) &&
    (value.finishedAt === undefined || isIsoDate(value.finishedAt)) &&
    (value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "cancelled") &&
    (value.runId === undefined || typeof value.runId === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
