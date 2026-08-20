import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("schedule CLI", () => {
  test("adds, lists, and removes tasks without constructing an Agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "andi-agent-schedule-cli-"));
    temporaryDirectories.push(directory);
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((message?: unknown) => {
      output.push(String(message));
    });
    try {
      await main([
        "schedule",
        "add",
        "future-check",
        "--cwd",
        directory,
        "--at",
        "2099-01-01T00:00:00Z",
        "--",
        "inspect project",
      ]);
      await main(["schedule", "list", "--cwd", directory]);
      await main(["schedule", "remove", "future-check", "--cwd", directory]);
    } finally {
      log.mockRestore();
    }

    expect(output[0]).toContain("已创建定时任务“future-check”");
    expect(output[1]).toContain("future-check\tenabled");
    expect(output[2]).toBe("已删除定时任务“future-check”。");
  });
});
