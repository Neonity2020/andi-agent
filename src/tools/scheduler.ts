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
         "仅在用户明确要求时创建本地定时任务。必须在 'at'（带时区的 ISO 8601）或 'every'（例如 15m、24h）中二选一。不要猜测缺失的时区。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "由字母、数字、下划线或连字符组成的稳定任务 ID" },
          task: { type: "string", description: "定时 Coding Agent 将执行的完整任务提示" },
          at: { type: "string", description: "带 Z 或明确时区偏移的一次性 ISO 8601 时间戳" },
          every: { type: "string", description: "固定间隔，例如 10s、15m、2h 或 1d" },
          session_id: { type: "string", description: "可选的持久会话 ID" },
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
      description: "列出本地定时任务，包括提示、计划、会话、下次运行时间和最近状态。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        requireRecord(input);
        return { tasks: (await store.list()).map(summarizeTask) };
      },
    },
    {
      name: "schedule_remove",
      description: "仅在用户明确要求删除时移除本地定时任务。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "定时任务 ID" } },
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
         "仅在用户明确要求时立即运行已有定时任务。运行过程不可交互，不能批准不安全命令或 Git 写入。",
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
