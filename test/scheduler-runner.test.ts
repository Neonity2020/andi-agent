import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "../src/model/types";
import { createScheduledAgentRunner } from "../src/scheduler/runner";
import type { ScheduledTask } from "../src/scheduler/types";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { MemoryStore } from "../src/memory/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("createScheduledAgentRunner", () => {
  test("persists session checkpoints, usage, and sanitized run events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "andi-agent-scheduled-runner-"));
    temporaryDirectories.push(directory);
    const workspace = await Workspace.create(directory);
    await new MemoryStore(workspace).remember({
      id: "scheduled-work",
      title: "Scheduled Work Convention",
      tags: ["scheduled", "work"],
      content: "Scheduled work should produce concise output.",
    });
    let receivedToolNames: string[] = [];
    let receivedMessages: readonly import("../src/model/types").Message[] = [];
    const model: ModelProvider = {
      async complete(messages, tools) {
        receivedMessages = messages;
        receivedToolNames = tools.map((tool) => tool.name);
        return {
          content: "scheduled work complete",
          toolCalls: [],
          usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
        };
      },
    };
    const runner = createScheduledAgentRunner({
      workspace,
      model,
      config: {
        apiKey: "unused",
        model: "fake",
        baseUrl: "https://example.invalid/v1",
        maxTurns: 3,
        maxContextChars: 10_000,
        exa: { apiKey: "exa-key", baseUrl: "https://api.exa.test" },
      },
    });
    const task: ScheduledTask = {
      id: "daily",
      task: "do scheduled work",
      sessionId: "schedule-daily",
      schedule: { kind: "interval", everyMs: 60_000 },
      enabled: true,
      createdAt: "2026-08-19T00:00:00.000Z",
      nextRunAt: "2026-08-19T00:01:00.000Z",
    };

    const result = await runner(task);
    const snapshot = await new SessionStore(workspace).loadSnapshot(task.sessionId);
    const log = await workspace.read(`.andi-agent/runs/${result.runId}.jsonl`);

    expect(result.output).toBe("scheduled work complete");
    expect(snapshot.state).toBe("idle");
    expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant", content: "scheduled work complete" });
    expect(snapshot.usage).toMatchObject({ inputTokens: 8, outputTokens: 3, totalTokens: 11, modelRequests: 1 });
    expect(log).toContain('"type":"agent_completed"');
    expect(log).not.toContain("do scheduled work");
    expect(receivedToolNames).not.toContain("schedule_add");
    expect(receivedToolNames).not.toContain("schedule_run");
    expect(receivedToolNames).toContain("web_search");
    expect(receivedToolNames).toContain("memory_search");
    expect(receivedToolNames).toContain("memory_read");
    expect(receivedToolNames).toContain("knowledge_search");
    expect(receivedToolNames).toContain("knowledge_read");
    expect(receivedToolNames).not.toContain("knowledge_capture");
    expect(receivedToolNames).not.toContain("memory_remember");
    expect(receivedToolNames).not.toContain("memory_archive");
    expect(receivedMessages.some((message) => message.content?.includes("Scheduled work should produce concise output"))).toBeTrue();
  });
});
