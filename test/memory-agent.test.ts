import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "../src/agent";
import type { MemoryProvider } from "../src/memory/types";
import type { AssistantTurn, Message, ModelProvider } from "../src/model/types";
import { OperationCancelledError } from "../src/runtime/abort";
import { ToolRegistry } from "../src/tools/registry";
import { Workspace } from "../src/tools/workspace";
import { MemoryStore } from "../src/memory/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class CapturingModel implements ModelProvider {
  readonly requests: Message[][] = [];
  readonly response: AssistantTurn = { content: "done", toolCalls: [] };

  async complete(messages: readonly Message[]): Promise<AssistantTurn> {
    this.requests.push([...messages]);
    return this.response;
  }
}

describe("Agent memory context", () => {
  test("injects relevant memory ephemerally and reports metadata", async () => {
    const model = new CapturingModel();
    const events: AgentEvent[] = [];
    const checkpoints: Message[][] = [];
    const memory: MemoryProvider = {
      async buildContext() {
        return { content: "BEGIN WORKSPACE MEMORY\nBe concise.\nEND WORKSPACE MEMORY", ids: ["style"], chars: 61, truncated: false };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      memory,
      onEvent(event) {
        events.push(event);
      },
    });
    const result = await agent.runWithHistory("Use my preferred style", [], {
      onCheckpoint: async (checkpoint) => {
        checkpoints.push([...checkpoint.messages]);
      },
    });

    const memoryRequest = model.requests[0]?.[1];
    expect(memoryRequest?.role).toBe("user");
    expect(String(memoryRequest?.content)).toContain("Be concise");
    expect(String(memoryRequest?.content)).toContain("CURRENT USER REQUEST");
    expect(result.messages.some((message) => message.content?.includes("WORKSPACE MEMORY"))).toBeFalse();
    expect(checkpoints.flat().some((message) => message.content?.includes("WORKSPACE MEMORY"))).toBeFalse();
    expect(events).toContainEqual({
      type: "memory_context_loaded",
      runId: result.runId,
      ids: ["style"],
      chars: 61,
      truncated: false,
    });
  });

  test("does not inject empty memory and fails open with an observable event", async () => {
    const model = new CapturingModel();
    const events: AgentEvent[] = [];
    const memory: MemoryProvider = {
      async buildContext() {
        throw new Error("memory corrupt");
      },
    };
    await new Agent({
      model,
      tools: new ToolRegistry(),
      memory,
      onEvent(event) {
        events.push(event);
      },
    }).run("task");

    expect(model.requests[0]).toHaveLength(2);
    expect(events.some((event) => event.type === "memory_context_failed")).toBeTrue();
  });

  test("propagates cancellation during recall without calling the model", async () => {
    const model = new CapturingModel();
    const memory: MemoryProvider = {
      async buildContext() {
        throw new OperationCancelledError();
      },
    };
    await expect(new Agent({ model, tools: new ToolRegistry(), memory }).run("task")).rejects.toThrow(
      "Operation cancelled",
    );
    expect(model.requests).toHaveLength(0);
  });

  test("recalls disk memory in a fresh Agent instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-agent-memory-agent-"));
    temporaryDirectories.push(root);
    const workspace = await Workspace.create(root);
    await new MemoryStore(workspace).remember({
      id: "response-style",
      title: "Response Style",
      tags: ["preference", "concise"],
      content: "The user prefers concise answers with no unnecessary headings.",
    });
    const model = new CapturingModel();
    await new Agent({
      model,
      tools: new ToolRegistry(),
      memory: new MemoryStore(workspace),
    }).run("Follow my concise response preference");

    expect(model.requests[0]?.some((message) => message.content?.includes("prefers concise answers"))).toBeTrue();
  });
});
