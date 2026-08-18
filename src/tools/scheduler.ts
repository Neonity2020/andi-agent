import { parseDuration, parseScheduledAt, validateScheduledTaskId } from "../scheduler/parser";
import { TaskScheduler } from "../scheduler/scheduler";
import type { ScheduleStore } from "../scheduler/store";
import type { ScheduledTask, ScheduledTaskRunner, ScheduledTaskRunnerResult } from "../scheduler/types";
import { throwIfAborted } from "../runtime/abort";
import type { Tool } from "./types";
import { requireRecord, requireString } from "./validation";

export interface SchedulerToolOptions {
  runner: ScheduledTaskRunner;
}

export function createSchedulerTools(store: ScheduleStore, options: SchedulerToolOptions): Tool[] {
  return [
    {
      name: "schedule_add",
      description:
        "Create a local scheduled task only when the user explicitly asks. Provide exactly one of 'at' (zoned ISO 8601) or 'every' (for example 15m or 24h). Never guess a missing timezone.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Stable task ID using letters, numbers, underscores, or hyphens" },
          task: { type: "string", description: "Complete prompt that the scheduled coding agent will execute" },
          at: { type: "string", description: "One-time ISO 8601 timestamp with Z or an explicit timezone offset" },
          every: { type: "string", description: "Fixed interval such as 10s, 15m, 2h, or 1d" },
          session_id: { type: "string", description: "Optional persistent session ID" },
        },
        required: ["id", "task"],
        additionalProperties: false,
      },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        const values = requireRecord(input);
        const id = requireString(values, "id");
        const task = requireString(values, "task");
        const at = optionalString(values, "at");
        const every = optionalString(values, "every");
        const sessionId = optionalString(values, "session_id");
        validateScheduledTaskId(id);
        if (sessionId) validateScheduledTaskId(sessionId);
        if ((at === undefined) === (every === undefined)) {
          throw new Error("Provide exactly one of 'at' or 'every'");
        }
        const schedule = at
          ? { kind: "once" as const, at: parseScheduledAt(at) }
          : { kind: "interval" as const, everyMs: parseDuration(every as string) };
        const added = await store.add({ id, task, schedule, ...(sessionId ? { sessionId } : {}) });
        throwIfAborted(context?.signal);
        return { task: summarizeTask(added) };
      },
    },
    {
      name: "schedule_list",
      description: "List local scheduled tasks, including prompts, schedules, sessions, next runs, and recent status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        requireRecord(input);
        return { tasks: (await store.list()).map(summarizeTask) };
      },
    },
    {
      name: "schedule_remove",
      description: "Remove a local scheduled task only when the user explicitly asks to delete it.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Scheduled task ID" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        const id = requireString(requireRecord(input), "id");
        validateScheduledTaskId(id);
        return { id, removed: await store.remove(id) };
      },
    },
    {
      name: "schedule_run",
      description:
        "Immediately run an existing scheduled task only when the user explicitly requests it. The run is non-interactive and cannot approve unsafe commands or Git writes.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Scheduled task ID" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        const id = requireString(requireRecord(input), "id");
        validateScheduledTaskId(id);
        let runnerResult: ScheduledTaskRunnerResult | undefined;
        const scheduler = new TaskScheduler({
          store,
          async runner(task, signal) {
            runnerResult = await options.runner(task, signal);
            return runnerResult;
          },
        });
        const completed = await scheduler.runNow(id, context?.signal);
        return {
          task: summarizeTask(completed),
          ...(runnerResult?.output !== undefined ? { output: runnerResult.output } : {}),
        };
      },
    },
  ];
}

function summarizeTask(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    prompt: task.task,
    schedule: task.schedule,
    sessionId: task.sessionId,
    enabled: task.enabled,
    ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
    ...(task.lastRun ? { lastRun: task.lastRun } : {}),
  };
}

function optionalString(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Field '${key}' must be a non-empty string`);
  }
  return value;
}
