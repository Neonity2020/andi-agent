import type { ScheduleDefinition, ScheduledTaskInput } from "./types";

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ZONED_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/;
const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;

export type ScheduleCliCommand =
  | { action: "add"; cwd: string; input: ScheduledTaskInput }
  | { action: "list"; cwd: string }
  | { action: "remove"; cwd: string; id: string }
  | { action: "run"; cwd: string; id: string };

export interface SchedulerCliCommand {
  cwd: string;
  pollMs: number;
}

export function validateScheduledTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error("Scheduled task ID must use 1-64 letters, numbers, underscores, or hyphens");
  }
}

export function parseDuration(value: string): number {
  return parseDurationWithMinimum(value, MIN_INTERVAL_MS);
}

function parseDurationWithMinimum(value: string, minimum: number): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) throw new Error("Duration must use an integer followed by s, m, h, or d (for example 15m)");
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration < minimum || duration > MAX_INTERVAL_MS) {
    throw new Error(`Duration must be between ${minimum / 1_000}s and 365d`);
  }
  return duration;
}

export function parseScheduledAt(value: string, now = new Date()): string {
  const match = ZONED_ISO_PATTERN.exec(value);
  if (!match) {
    throw new Error("--at must be an ISO 8601 timestamp with Z or an explicit timezone offset");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const offsetHour = Number(match[9] ?? "0");
  const offsetMinute = Number(match[10] ?? "0");
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    throw new Error("--at contains an invalid date or time");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("--at contains an invalid date or time");
  if (timestamp <= now.getTime()) throw new Error("--at must be in the future");
  return new Date(timestamp).toISOString();
}

export function parseScheduleArguments(
  args: readonly string[],
  now = new Date(),
  defaultCwd = process.cwd(),
): ScheduleCliCommand {
  const action = args[0];
  if (action === "add") return parseAdd(args.slice(1), now, defaultCwd);
  if (action === "list") {
    return { action, cwd: parseOnlyCwd(args.slice(1), defaultCwd) };
  }
  if (action === "remove" || action === "run") {
    const { positional, cwd } = parseCwdOption(args.slice(1), defaultCwd);
    if (positional.length !== 1) throw new Error(`schedule ${action} requires exactly one task ID`);
    const id = positional[0] as string;
    validateScheduledTaskId(id);
    return { action, cwd, id };
  }
  throw new Error("schedule requires one of: add, list, remove, run");
}

export function parseSchedulerArguments(
  args: readonly string[],
  defaultCwd = process.cwd(),
): SchedulerCliCommand {
  let cwd = defaultCwd;
  let pollMs = 1_000;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--cwd") {
      cwd = requireOptionValue(args, ++index, "--cwd");
    } else if (argument === "--poll") {
      pollMs = parseDurationWithMinimum(requireOptionValue(args, ++index, "--poll"), 1_000);
    } else {
      throw new Error(`Unknown scheduler option: ${argument}`);
    }
  }
  return { cwd, pollMs };
}

function parseAdd(args: readonly string[], now: Date, defaultCwd: string): ScheduleCliCommand {
  const separator = args.indexOf("--");
  if (separator === -1) throw new Error("schedule add requires '--' before the task text");
  const options = args.slice(0, separator);
  const task = args.slice(separator + 1).join(" ").trim();
  if (task.length === 0) throw new Error("schedule add requires non-empty task text after '--'");
  const id = options[0];
  if (!id) throw new Error("schedule add requires a task ID");
  validateScheduledTaskId(id);

  let cwd = defaultCwd;
  let sessionId: string | undefined;
  let schedule: ScheduleDefinition | undefined;
  for (let index = 1; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--cwd") {
      cwd = requireOptionValue(options, ++index, "--cwd");
    } else if (option === "--session") {
      sessionId = requireOptionValue(options, ++index, "--session");
      validateScheduledTaskId(sessionId);
    } else if (option === "--at") {
      if (schedule) throw new Error("schedule add accepts exactly one of --at or --every");
      schedule = { kind: "once", at: parseScheduledAt(requireOptionValue(options, ++index, "--at"), now) };
    } else if (option === "--every") {
      if (schedule) throw new Error("schedule add accepts exactly one of --at or --every");
      schedule = { kind: "interval", everyMs: parseDuration(requireOptionValue(options, ++index, "--every")) };
    } else {
      throw new Error(`Unknown schedule add option: ${option}`);
    }
  }
  if (!schedule) throw new Error("schedule add requires exactly one of --at or --every");
  return { action: "add", cwd, input: { id, task, schedule, ...(sessionId ? { sessionId } : {}) } };
}

function parseOnlyCwd(args: readonly string[], defaultCwd: string): string {
  const { positional, cwd } = parseCwdOption(args, defaultCwd);
  if (positional.length > 0) throw new Error("schedule list does not accept positional arguments");
  return cwd;
}

function parseCwdOption(args: readonly string[], defaultCwd: string): { positional: string[]; cwd: string } {
  const positional: string[] = [];
  let cwd = defaultCwd;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--cwd") cwd = requireOptionValue(args, ++index, "--cwd");
    else if (args[index]?.startsWith("-")) throw new Error(`Unknown option: ${args[index]}`);
    else positional.push(args[index] as string);
  }
  return { positional, cwd };
}

function requireOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}
