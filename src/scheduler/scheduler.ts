import { isCancellationError, throwIfAborted } from "../runtime/abort";
import type { ScheduleStore } from "./store";
import type { ScheduledRunStatus, ScheduledTask, ScheduledTaskRunner } from "./types";

export interface TaskSchedulerOptions {
  store: ScheduleStore;
  runner: ScheduledTaskRunner;
  pollMs?: number;
  now?: () => Date;
  onError?: (task: ScheduledTask, error: unknown) => void;
}

export class TaskScheduler {
  readonly #store: ScheduleStore;
  readonly #runner: ScheduledTaskRunner;
  readonly #pollMs: number;
  readonly #now: () => Date;
  readonly #onError: ((task: ScheduledTask, error: unknown) => void) | undefined;

  constructor(options: TaskSchedulerOptions) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#pollMs = options.pollMs ?? 1_000;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs < 1) throw new Error("pollMs must be a positive integer");
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.#store.recoverInterrupted(this.#now());
    while (!signal?.aborted) {
      await this.runDue(signal);
      if (signal?.aborted) break;
      await wait(this.#pollMs, signal);
    }
  }

  async runDue(signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    const now = this.#now();
    const due = (await this.#store.list())
      .filter((task) => task.enabled && task.nextRunAt !== undefined && Date.parse(task.nextRunAt) <= now.getTime())
      .sort((left, right) => Date.parse(left.nextRunAt as string) - Date.parse(right.nextRunAt as string));
    let count = 0;
    for (const task of due) {
      throwIfAborted(signal);
      await this.#execute(task, true, signal);
      count += 1;
    }
    return count;
  }

  async runNow(id: string, signal?: AbortSignal): Promise<ScheduledTask> {
    throwIfAborted(signal);
    const task = await this.#store.get(id);
    if (!task) throw new Error(`Scheduled task '${id}' does not exist`);
    return this.#execute(task, false, signal);
  }

  async #execute(task: ScheduledTask, consumeSchedule: boolean, signal?: AbortSignal): Promise<ScheduledTask> {
    const startedAt = this.#now();
    const running: ScheduledTask = {
      ...task,
      lastRun: { startedAt: startedAt.toISOString(), status: "running" },
    };
    if (consumeSchedule) {
      const next = nextScheduleState(task, startedAt);
      running.enabled = next.enabled;
      if (next.nextRunAt) running.nextRunAt = next.nextRunAt;
      else delete running.nextRunAt;
    }
    await this.#store.replace(running);

    try {
      const result = await this.#runner(running, signal);
      return await this.#finish(running, "completed", result.runId);
    } catch (error) {
      const cancelled = signal?.aborted === true || isCancellationError(error);
      const status: ScheduledRunStatus = cancelled ? "cancelled" : "failed";
      const finished = await this.#finish(
        running,
        status,
        errorRunId(error),
        truncateError(error instanceof Error ? error.message : String(error)),
      );
      if (cancelled) throw error;
      this.#onError?.(finished, error);
      return finished;
    }
  }

  async #finish(
    task: ScheduledTask,
    status: Exclude<ScheduledRunStatus, "running">,
    runId?: string,
    error?: string,
  ): Promise<ScheduledTask> {
    const finished: ScheduledTask = {
      ...task,
      lastRun: {
        startedAt: task.lastRun?.startedAt ?? this.#now().toISOString(),
        finishedAt: this.#now().toISOString(),
        status,
        ...(runId ? { runId } : {}),
        ...(error ? { error } : {}),
      },
    };
    await this.#store.replace(finished);
    return finished;
  }
}

export function nextScheduleState(
  task: ScheduledTask,
  now: Date,
): { enabled: boolean; nextRunAt: string | undefined } {
  if (task.schedule.kind === "once") return { enabled: false, nextRunAt: undefined };
  const current = task.nextRunAt ? Date.parse(task.nextRunAt) : now.getTime();
  const elapsedIntervals = Math.floor((now.getTime() - current) / task.schedule.everyMs) + 1;
  const next = current + Math.max(1, elapsedIntervals) * task.schedule.everyMs;
  return { enabled: true, nextRunAt: new Date(next).toISOString() };
}

function truncateError(error: string): string {
  return error.replace(/\s+/g, " ").slice(0, 500);
}

function errorRunId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("runId" in error)) return undefined;
  return typeof error.runId === "string" ? error.runId : undefined;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
