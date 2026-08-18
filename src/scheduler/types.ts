export type ScheduleDefinition =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number };

export type ScheduledRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface ScheduledRun {
  startedAt: string;
  finishedAt?: string;
  status: ScheduledRunStatus;
  runId?: string;
  error?: string;
}

export interface ScheduledTask {
  id: string;
  task: string;
  schedule: ScheduleDefinition;
  sessionId: string;
  enabled: boolean;
  createdAt: string;
  nextRunAt?: string;
  lastRun?: ScheduledRun;
}

export interface ScheduleRegistry {
  version: 1;
  tasks: ScheduledTask[];
}

export interface ScheduledTaskInput {
  id: string;
  task: string;
  schedule: ScheduleDefinition;
  sessionId?: string;
}

export interface ScheduledTaskRunnerResult {
  runId?: string;
  output?: string;
}

export type ScheduledTaskRunner = (
  task: ScheduledTask,
  signal?: AbortSignal,
) => Promise<ScheduledTaskRunnerResult>;
