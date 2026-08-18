import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationCancelledError } from "../src/runtime/abort";
import { TaskScheduler } from "../src/scheduler/scheduler";
import { ScheduleStore } from "../src/scheduler/store";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<ScheduleStore> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-scheduler-"));
  temporaryDirectories.push(directory);
  return new ScheduleStore(await Workspace.create(directory));
}

describe("TaskScheduler", () => {
  test("runs a one-time task once and disables it before execution", async () => {
    const store = await setup();
    const createdAt = new Date("2026-08-19T00:00:00.000Z");
    const dueAt = new Date("2026-08-19T00:01:00.000Z");
    await store.add({ id: "once", task: "inspect", schedule: { kind: "once", at: dueAt.toISOString() } }, createdAt);
    const seenEnabled: boolean[] = [];
    const scheduler = new TaskScheduler({
      store,
      now: () => dueAt,
      async runner(task) {
        seenEnabled.push(task.enabled);
        return { runId: "run-1" };
      },
    });

    expect(await scheduler.runDue()).toBe(1);
    expect(await scheduler.runDue()).toBe(0);
    expect(seenEnabled).toEqual([false]);
    expect(await store.get("once")).toMatchObject({
      enabled: false,
      lastRun: { status: "completed", runId: "run-1" },
    });
  });

  test("advances missed intervals into the future without burst reruns", async () => {
    const store = await setup();
    const createdAt = new Date("2026-08-19T00:00:00.000Z");
    const now = new Date("2026-08-19T00:00:35.000Z");
    await store.add(
      { id: "repeat", task: "inspect", schedule: { kind: "interval", everyMs: 10_000 } },
      createdAt,
    );
    let runs = 0;
    const scheduler = new TaskScheduler({
      store,
      now: () => now,
      async runner() {
        runs += 1;
        return {};
      },
    });

    expect(await scheduler.runDue()).toBe(1);
    expect(await scheduler.runDue()).toBe(0);
    expect(runs).toBe(1);
    expect((await store.get("repeat"))?.nextRunAt).toBe("2026-08-19T00:00:40.000Z");
  });

  test("continues with later due tasks after a failure and runs serially", async () => {
    const store = await setup();
    const createdAt = new Date("2026-08-19T00:00:00.000Z");
    const now = new Date("2026-08-19T00:01:00.000Z");
    for (const id of ["first", "second"]) {
      await store.add({ id, task: id, schedule: { kind: "once", at: now.toISOString() } }, createdAt);
    }
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new TaskScheduler({
      store,
      now: () => now,
      async runner(task) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push(task.id);
        active -= 1;
        if (task.id === "first") throw Object.assign(new Error("boom"), { runId: "failed-run" });
        return {};
      },
    });

    expect(await scheduler.runDue()).toBe(2);
    expect(calls).toEqual(["first", "second"]);
    expect(maximumActive).toBe(1);
    expect((await store.get("first"))?.lastRun).toMatchObject({ status: "failed", runId: "failed-run" });
    expect((await store.get("second"))?.lastRun?.status).toBe("completed");
  });

  test("cancels an active manual run and persists cancelled status", async () => {
    const store = await setup();
    await store.add(
      { id: "waiting", task: "wait", schedule: { kind: "interval", everyMs: 10_000 } },
      new Date("2026-08-19T00:00:00.000Z"),
    );
    const controller = new AbortController();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const scheduler = new TaskScheduler({
      store,
      async runner(_task, signal) {
        notifyStarted?.();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new OperationCancelledError()), { once: true });
        });
      },
    });
    const running = scheduler.runNow("waiting", controller.signal);
    await started;
    controller.abort();

    await expect(running).rejects.toThrow("Operation cancelled");
    expect((await store.get("waiting"))?.lastRun?.status).toBe("cancelled");
  });
});
