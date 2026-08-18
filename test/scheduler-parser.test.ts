import { describe, expect, test } from "bun:test";
import {
  parseDuration,
  parseScheduleArguments,
  parseScheduledAt,
  parseSchedulerArguments,
} from "../src/scheduler/parser";

const NOW = new Date("2026-08-19T00:00:00.000Z");

describe("scheduler parser", () => {
  test("parses interval and zoned one-time schedules", () => {
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseScheduledAt("2026-08-20T09:00:00+08:00", NOW)).toBe("2026-08-20T01:00:00.000Z");

    expect(
      parseScheduleArguments(
        ["add", "nightly", "--every", "24h", "--session", "nightly-session", "--", "run", "tests"],
        NOW,
        "/workspace",
      ),
    ).toEqual({
      action: "add",
      cwd: "/workspace",
      input: {
        id: "nightly",
        task: "run tests",
        sessionId: "nightly-session",
        schedule: { kind: "interval", everyMs: 86_400_000 },
      },
    });
  });

  test("rejects ambiguous, unsafe, and invalid times", () => {
    expect(() => parseDuration("5s")).toThrow("between 10s");
    expect(() => parseScheduledAt("2026-08-20T09:00:00", NOW)).toThrow("timezone");
    expect(() => parseScheduledAt("2026-02-30T09:00:00Z", NOW)).toThrow("invalid");
    expect(() =>
      parseScheduleArguments(
        ["add", "job", "--at", "2026-08-20T09:00:00Z", "--every", "1h", "--", "task"],
        NOW,
      ),
    ).toThrow("exactly one");
    expect(() => parseScheduleArguments(["remove", "../job"], NOW)).toThrow("task ID");
  });

  test("parses management and daemon options", () => {
    expect(parseScheduleArguments(["list", "--cwd", "/repo"], NOW)).toEqual({
      action: "list",
      cwd: "/repo",
    });
    expect(parseSchedulerArguments(["--cwd", "/repo", "--poll", "1s"])).toEqual({
      cwd: "/repo",
      pollMs: 1_000,
    });
  });
});
