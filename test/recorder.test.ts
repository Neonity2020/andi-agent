import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunRecorder } from "../src/runtime/recorder";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunRecorder", () => {
  test("records metadata, skips text deltas, and redacts secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-agent-recorder-"));
    temporaryDirectories.push(root);
    const workspace = await Workspace.create(root);
    const recorder = new RunRecorder(workspace);

    await recorder.record({ type: "turn_started", runId: "run-1", turn: 1, messageCount: 2 });
    await recorder.record({ type: "model_text_delta", runId: "run-1", turn: 1, delta: "private prompt" });
    await recorder.record({ type: "agent_failed", runId: "run-1", error: "Bearer secret-token" });

    const log = await workspace.read(".andi-agent/runs/run-1.jsonl");
    expect(log).toContain("turn_started");
    expect(log).not.toContain("private prompt");
    expect(log).not.toContain("secret-token");
    expect(log).toContain("[REDACTED]");
  });
});
