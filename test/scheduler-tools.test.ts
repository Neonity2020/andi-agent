import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationCancelledError } from "../src/runtime/abort";
import { ScheduleStore } from "../src/scheduler/store";
import { ToolRegistry } from "../src/tools/registry";
import { createSchedulerTools, __setScheduleRunTimeoutMsForTests } from "../src/tools/scheduler";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(
  runner: Parameters<typeof createSchedulerTools>[1]["runner"] = async () => ({}),
): Promise<{ registry: ToolRegistry; store: ScheduleStore }> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-scheduler-tools-"));
  temporaryDirectories.push(directory);
  const store = new ScheduleStore(await Workspace.create(directory));
  return { registry: new ToolRegistry(createSchedulerTools(store, { runner })), store };
}

describe("scheduler tools", () => {
  test("registers four stable model-facing tools", async () => {
    const { registry } = await setup();
    expect(registry.definitions().map((tool) => tool.name)).toEqual([
      "schedule_add",
      "schedule_list",
      "schedule_remove",
      "schedule_run",
    ]);
  });

  test("adds, lists, and removes a scheduled task", async () => {
    const { registry } = await setup();
    const added = await registry.execute(
      "schedule_add",
      JSON.stringify({
        id: "daily-check",
        task: "run tests",
        every: "24h",
        session_id: "daily-session",
      }),
    );
    const listed = await registry.execute("schedule_list", "{}");
    const removed = await registry.execute("schedule_remove", JSON.stringify({ id: "daily-check" }));
    const missing = await registry.execute("schedule_remove", JSON.stringify({ id: "daily-check" }));

    expect(added).toMatchObject({
      ok: true,
      value: { task: { id: "daily-check", sessionId: "daily-session", enabled: true } },
    });
    expect(listed).toMatchObject({ ok: true, value: { tasks: [{ id: "daily-check", prompt: "run tests" }] } });
    expect(removed).toEqual({ ok: true, value: { id: "daily-check", removed: true } });
    expect(missing).toEqual({ ok: true, value: { id: "daily-check", removed: false } });
  });

  test("validates exclusive schedule inputs and zoned timestamps", async () => {
    const { registry } = await setup();
    const both = await registry.execute(
      "schedule_add",
      JSON.stringify({ id: "bad", task: "task", at: "2099-01-01T00:00:00Z", every: "1h" }),
    );
    const unzoned = await registry.execute(
      "schedule_add",
      JSON.stringify({ id: "bad-time", task: "task", at: "2099-01-01T00:00:00" }),
    );

    expect(both).toEqual({ ok: false, error: "Provide exactly one of 'at' or 'every'" });
    expect(unzoned).toMatchObject({ ok: false });
    if (!unzoned.ok) expect(unzoned.error).toContain("timezone");
  });

  test("runs an existing task and returns output with persisted status", async () => {
    const { registry, store } = await setup(async (task) => ({
      runId: `run-${task.id}`,
      output: "tests passed",
    }));
    await store.add(
      { id: "run-me", task: "run tests", schedule: { kind: "interval", everyMs: 60_000 } },
      new Date("2026-08-19T00:00:00.000Z"),
    );

    const result = await registry.execute("schedule_run", JSON.stringify({ id: "run-me" }));

    expect(result).toMatchObject({
      ok: true,
      value: {
        output: "tests passed",
        task: { id: "run-me", lastRun: { status: "completed", runId: "run-run-me" } },
      },
    });
    expect((await store.get("run-me"))?.lastRun).toMatchObject({ status: "completed", runId: "run-run-me" });
  });

  test("propagates cancellation from an immediate run", async () => {
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const { registry, store } = await setup(async (_task, signal) => {
      notifyStarted?.();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new OperationCancelledError()), { once: true });
      });
    });
    await store.add(
      { id: "cancel-me", task: "wait", schedule: { kind: "interval", everyMs: 60_000 } },
      new Date("2026-08-19T00:00:00.000Z"),
    );
    const controller = new AbortController();
    const running = registry.execute("schedule_run", JSON.stringify({ id: "cancel-me" }), {
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(running).rejects.toThrow("Operation cancelled");
    expect((await store.get("cancel-me"))?.lastRun?.status).toBe("cancelled");
  });

  test("returns timeout fallback when the runner exceeds the schedule_run budget", async () => {
    const ORIGINAL_TIMEOUT = 10 * 60 * 1000;
    __setScheduleRunTimeoutMsForTests(20);
    try {
      let notifyStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const { registry, store } = await setup(async (_task, signal) => {
        notifyStarted?.();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new OperationCancelledError()), { once: true });
        });
      });
      await store.add(
        { id: "timeout-me", task: "wait", schedule: { kind: "interval", everyMs: 60_000 } },
        new Date("2026-08-19T00:00:00.000Z"),
      );

      const result = await registry.execute("schedule_run", JSON.stringify({ id: "timeout-me" }));
      await started;

      expect(result).toMatchObject({
        ok: true,
        value: {
          task: { id: "timeout-me" },
          error: "schedule_run timed out after 10min",
        },
      });
    } finally {
      __setScheduleRunTimeoutMsForTests(ORIGINAL_TIMEOUT);
    }
  });
});
