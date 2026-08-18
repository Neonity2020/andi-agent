import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "../src/scheduler/store";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<{ store: ScheduleStore; workspace: Workspace }> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-schedules-"));
  temporaryDirectories.push(directory);
  const workspace = await Workspace.create(directory);
  return { store: new ScheduleStore(workspace), workspace };
}

describe("ScheduleStore", () => {
  test("adds, lists, replaces, and removes persistent tasks", async () => {
    const { store, workspace } = await setup();
    const now = new Date("2026-08-19T00:00:00.000Z");
    const added = await store.add(
      { id: "nightly", task: "run tests", schedule: { kind: "interval", everyMs: 60_000 } },
      now,
    );

    expect(added.nextRunAt).toBe("2026-08-19T00:01:00.000Z");
    expect(added.sessionId).toBe("schedule-nightly");
    expect(await store.list()).toEqual([added]);
    expect(() => workspace.assertToolPath(".andi-agent/schedules.json")).toThrow("reserved");

    added.enabled = false;
    await store.replace(added);
    expect((await store.get("nightly"))?.enabled).toBeFalse();
    expect(await store.remove("nightly")).toBeTrue();
    expect(await store.list()).toEqual([]);
  });

  test("rejects duplicates and malformed registries", async () => {
    const { store, workspace } = await setup();
    const input = {
      id: "once",
      task: "inspect",
      schedule: { kind: "once" as const, at: "2026-08-20T00:00:00.000Z" },
    };
    await store.add(input, new Date("2026-08-19T00:00:00.000Z"));
    await expect(store.add(input, new Date("2026-08-19T00:00:00.000Z"))).rejects.toThrow("already exists");

    await workspace.write(".andi-agent/schedules.json", "{bad json");
    await expect(store.list()).rejects.toThrow("invalid JSON");
  });

  test("marks an interrupted run failed on recovery", async () => {
    const { store } = await setup();
    const task = await store.add(
      { id: "recover", task: "inspect", schedule: { kind: "interval", everyMs: 60_000 } },
      new Date("2026-08-19T00:00:00.000Z"),
    );
    task.lastRun = { startedAt: "2026-08-19T00:00:10.000Z", status: "running" };
    await store.replace(task);

    expect(await store.recoverInterrupted(new Date("2026-08-19T00:00:20.000Z"))).toBe(1);
    expect((await store.get("recover"))?.lastRun).toMatchObject({
      status: "failed",
      finishedAt: "2026-08-19T00:00:20.000Z",
    });
  });
});
