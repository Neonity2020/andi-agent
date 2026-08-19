import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import type { AssistantTurn, Message, ModelProvider, ModelToolDefinition } from "../src/model/types";
import { ToolRegistry } from "../src/tools/registry";

class ScriptedModel implements ModelProvider {
  readonly requests: Message[][] = [];
  readonly #responses: AssistantTurn[];

  constructor(responses: AssistantTurn[]) {
    this.#responses = [...responses];
  }

  async complete(messages: readonly Message[], _tools: readonly ModelToolDefinition[]): Promise<AssistantTurn> {
    this.requests.push([...messages]);
    const response = this.#responses.shift();
    if (!response) throw new Error("No scripted response available");
    return response;
  }
}

describe("Agent", () => {
  test("executes a tool call and returns the final response", async () => {
    const model = new ScriptedModel([
      {
        content: null,
        toolCalls: [{ id: "call-1", name: "echo", arguments: '{"text":"hello"}' }],
      },
      { content: "Done", toolCalls: [] },
    ]);
    const tools = new ToolRegistry([
      {
        name: "echo",
        description: "Echo text",
        parameters: { type: "object" },
        async execute(input) {
          return input;
        },
      },
    ]);

    const result = await new Agent({ model, tools }).run("Say hello");

    expect(result).toBe("Done");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      name: "echo",
      content: '{"ok":true,"value":{"text":"hello"}}',
    });
  });

  test("stops after the configured turn limit", async () => {
    const loopingTurn = {
      content: null,
      toolCalls: [{ id: "loop", name: "missing", arguments: "{}" }],
    };
    const model = new ScriptedModel([loopingTurn, loopingTurn]);
    const agent = new Agent({ model, tools: new ToolRegistry(), maxTurns: 2 });

    expect(agent.run("Loop")).rejects.toThrow("maximum of 2 turns");
  });

  test("emits ordered runtime events and accepts prior history", async () => {
    const model = new ScriptedModel([{ content: "continued", toolCalls: [] }]);
    const eventTypes: string[] = [];
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      onEvent(event) {
        eventTypes.push(event.type);
      },
    });

    const result = await agent.runWithHistory("continue", [
      { role: "system", content: "system" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "context", toolCalls: [] },
    ]);

    expect(result.output).toBe("continued");
    expect(model.requests[0]?.some((message) => message.role === "user" && message.content === "earlier")).toBeTrue();
    expect(eventTypes).toEqual(["turn_started", "model_completed", "agent_completed"]);
  });

  test("injects the current provider and model identity on every run", async () => {
    let identity = { provider: "agnes", model: "agnes-2.5-flash" };
    const requests: Message[][] = [];
    const model: ModelProvider = {
      getModelIdentity: () => identity,
      async complete(messages) {
        requests.push([...messages]);
        return { content: "ok", toolCalls: [] };
      },
    };
    const agent = new Agent({ model, tools: new ToolRegistry() });

    await agent.run("continue the task");
    identity = { provider: "minimax", model: "MiniMax-M2.7" };
    await agent.run("continue the task now");

    expect(requests[0]?.[0]?.content).toContain("Provider: agnes");
    expect(requests[0]?.[0]?.content).toContain("Model: agnes-2.5-flash");
    expect(requests[1]?.[0]?.content).toContain("Provider: minimax");
    expect(requests[1]?.[0]?.content).toContain("Model: MiniMax-M2.7");
    expect(requests[1]?.[0]?.content).not.toContain("currently running on:");
  });

  test("answers explicit model identity questions from runtime state", async () => {
    let calls = 0;
    const model: ModelProvider = {
      getModelIdentity: () => ({ provider: "minimax", model: "MiniMax-M2.7" }),
      async complete() {
        calls += 1;
        return { content: "wrong model", toolCalls: [] };
      },
    };

    const result = await new Agent({ model, tools: new ToolRegistry() }).runWithHistory("你现在使用的是哪款模型？");

    expect(result.output).toBe("当前使用的模型是 MiniMax-M2.7（Provider: minimax）。");
    expect(calls).toBe(0);
  });

  test("emits a compaction event when old turns exceed the budget", async () => {
    const model = new ScriptedModel([{ content: "done", toolCalls: [] }]);
    const eventTypes: string[] = [];
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      maxContextChars: 200,
      onEvent(event) {
        eventTypes.push(event.type);
      },
    });

    await agent.runWithHistory("new task", [
      { role: "system", content: "system" },
      { role: "user", content: "old".repeat(200) },
      { role: "assistant", content: "old answer", toolCalls: [] },
    ]);

    expect(eventTypes[0]).toBe("context_compacted");
  });

  test("forwards model text deltas as runtime events", async () => {
    const model: ModelProvider = {
      async complete(_messages, _tools, options) {
        await options?.onTextDelta?.("Hello");
        await options?.onTextDelta?.(" world");
        return { content: "Hello world", toolCalls: [] };
      },
    };
    const deltas: string[] = [];
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      onEvent(event) {
        if (event.type === "model_text_delta") deltas.push(event.delta);
      },
    });

    expect(await agent.run("greet")).toBe("Hello world");
    expect(deltas).toEqual(["Hello", " world"]);
  });

  test("checkpoints messages, aggregates usage, and reports cancellation", async () => {
    const checkpoints: Array<{ state: string; messages: number; tokens: number }> = [];
    const events: string[] = [];
    const controller = new AbortController();
    const model: ModelProvider = {
      async complete(_messages, _tools, options) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      onEvent(event) {
        events.push(event.type);
      },
    });
    const running = agent.runWithHistory("wait", [], {
      signal: controller.signal,
      async onCheckpoint(checkpoint) {
        checkpoints.push({
          state: checkpoint.state,
          messages: checkpoint.messages.length,
          tokens: checkpoint.usage.totalTokens,
        });
      },
    });
    setTimeout(() => controller.abort(), 10);

    await expect(running).rejects.toThrow("Operation cancelled");
    expect(checkpoints.map((checkpoint) => checkpoint.state)).toEqual(["running", "cancelled"]);
    expect(checkpoints[0]?.messages).toBe(2);
    expect(events).toContain("agent_cancelled");
  });

  test("returns aggregated model usage", async () => {
    const model = new ScriptedModel([
      {
        content: "done",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      },
    ]);
    const result = await new Agent({ model, tools: new ToolRegistry() }).runWithHistory("count");

    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, totalTokens: 13, modelRequests: 1 });
  });

  test("default system prompt points at the kb and honors a custom kbPath", async () => {
    const defaultModel = new ScriptedModel([{ content: "ok", toolCalls: [] }]);
    const defaultAgent = new Agent({ model: defaultModel, tools: new ToolRegistry() });
    await defaultAgent.run("ready");
    const system = defaultModel.requests[0]?.[0] as Message | undefined;
    expect(system?.role).toBe("system");
    expect(system?.content).toContain('If \"kb/README.md\" exists in the current workspace');
    expect(system?.content).toContain("Use durable workspace memory when a task refers to previous work");
    expect(system?.content).toContain("Use memory_remember only for stable project facts");

    const customModel = new ScriptedModel([{ content: "ok", toolCalls: [] }]);
    const customAgent = new Agent({ model: customModel, tools: new ToolRegistry(), kbPath: ".knowledge" });
    await customAgent.run("ready");
    const customSystem = customModel.requests[0]?.[0] as Message | undefined;
    expect(customSystem?.role).toBe("system");
    expect(customSystem?.content).toContain('If \".knowledge/README.md\" exists in the current workspace');
  });
});
