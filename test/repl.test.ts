import { describe, expect, test } from "bun:test";
import type { AgentRunResult } from "../src/agent";
import type { Message } from "../src/model/types";
import { resolveModelSelection, runRepl, type ReplAgent, type ReplIO } from "../src/repl";
import { OperationCancelledError } from "../src/runtime/abort";

function scriptedIO(inputs: Array<string | null>): ReplIO & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    async read() {
      return inputs.shift() ?? null;
    },
    write(message) {
      output.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };
}

function appendResult(task: string, history: readonly Message[]): AgentRunResult {
  return {
    output: `answer: ${task}`,
    runId: `run-${task}`,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelRequests: 1, modelDurationMs: 0 },
    messages: [
      ...history,
      { role: "user", content: task },
      { role: "assistant", content: `answer: ${task}`, toolCalls: [] },
    ],
  };
}

describe("runRepl", () => {
  test("keeps history across turns and saves each successful result", async () => {
    const io = scriptedIO(["first", "second", "/exit"]);
    const historySizes: number[] = [];
    const saved: Message[][] = [];
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        historySizes.push(history.length);
        return appendResult(task, history);
      },
    };

    const history = await runRepl({
      agent,
      io,
      sessionId: "demo",
      sessionStore: {
        async save(_id, messages) {
          saved.push([...messages]);
        },
      },
    });

    expect(historySizes).toEqual([0, 2]);
    expect(saved).toHaveLength(2);
    expect(history).toHaveLength(4);
    expect(io.output).toContain("answer: first");
  });

  test("continues after a failed turn without replacing successful history", async () => {
    const io = scriptedIO(["fails", "works", "/exit"]);
    let calls = 0;
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        calls += 1;
        if (task === "fails") throw new Error("temporary failure");
        return appendResult(task, history);
      },
    };

    const history = await runRepl({ agent, io });

    expect(calls).toBe(2);
    expect(history).toHaveLength(2);
    expect(io.errors).toContain("[error] temporary failure");
  });

  test("supports status, clear, unknown commands, and EOF", async () => {
    const io = scriptedIO(["/status", "/clear", "/status", "/unknown", null]);
    const saved: Message[][] = [];
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };

    const history = await runRepl({
      agent,
      io,
      initialHistory: [{ role: "user", content: "old" }],
      sessionId: "demo",
      sessionStore: {
        async save(_id, messages) {
          saved.push([...messages]);
        },
      },
    });

    expect(history).toEqual([]);
    expect(saved).toEqual([[]]);
    expect(io.output).toContain("session: demo · model: unknown · state: idle · messages: 1");
    expect(io.output).toContain("session: demo · model: unknown · state: idle · messages: 0");
    expect(io.errors[0]).toContain("Unknown REPL command");
  });

  test("keeps running when session persistence fails", async () => {
    const io = scriptedIO(["first", "second", "/exit"]);
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };

    const history = await runRepl({
      agent,
      io,
      sessionId: "demo",
      sessionStore: {
        async save() {
          throw new Error("disk unavailable");
        },
      },
    });

    expect(history).toHaveLength(4);
    expect(io.output).toContain("answer: second");
    expect(io.errors).toHaveLength(2);
    expect(io.errors[0]).toContain("Failed to save session");
  });

  test("cancels the active turn on interrupt and keeps the REPL alive", async () => {
    let interrupt: (() => void) | undefined;
    const io = scriptedIO(["wait", "/exit"]);
    io.onInterrupt = (handler) => {
      interrupt = handler;
    };
    const agent: ReplAgent = {
      async runWithHistory(_task, _history, options) {
        setTimeout(() => interrupt?.(), 0);
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new OperationCancelledError()),
            { once: true },
          );
        });
      },
    };

    await runRepl({ agent, io });

    expect(io.errors).toContain("Cancelling current turn...");
    expect(io.output).toContain("Turn cancelled.");
    expect(io.output).toContain("REPL closed.");
  });

  test("exits when interrupted at the idle prompt", async () => {
    const output: string[] = [];
    let interrupt: (() => void) | undefined;
    let finishRead: ((value: null) => void) | undefined;
    const io: ReplIO = {
      async read() {
        setTimeout(() => interrupt?.(), 0);
        return new Promise<null>((resolve) => {
          finishRead = resolve;
        });
      },
      write(message) {
        output.push(message);
      },
      error() {},
      onInterrupt(handler) {
        interrupt = handler;
      },
      close() {
        finishRead?.(null);
      },
    };
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };

    await runRepl({ agent, io });

    expect(output).toContain("REPL closed.");
  });

  test("aborts an active turn and exits when the global exit binding fires", async () => {
    let exit: (() => void) | undefined;
    let closed = 0;
    const io = scriptedIO(["wait"]);
    io.onExit = (handler) => {
      exit = handler;
    };
    io.close = () => {
      closed += 1;
    };
    const agent: ReplAgent = {
      async runWithHistory(_task, _history, options) {
        setTimeout(() => exit?.(), 0);
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new OperationCancelledError()),
            { once: true },
          );
        });
      },
    };

    await runRepl({ agent, io });

    expect(closed).toBe(1);
    expect(io.output).toContain("Turn cancelled.");
  });

  test("reports usage and manually repairs an incomplete tool call", async () => {
    const io = scriptedIO(["/usage", "/recover", "/exit"]);
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };
    const history = await runRepl({
      agent,
      io,
      initialUsage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        modelRequests: 2,
        modelDurationMs: 25,
      },
      initialHistory: [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "missing", name: "read_file", arguments: "{}" }],
        },
      ],
    });

    expect(io.output).toContain("session: 12 input · 3 output · 15 total tokens · 2 request(s) · 25ms");
    expect(io.output).toContain("Recovery complete · repaired 1 missing tool result(s).");
    expect(history[1]).toMatchObject({ role: "tool", toolCallId: "missing" });
  });

  test("lists, searches, and shows durable memory without calling the model", async () => {
    const io = scriptedIO(["/memory", "/memory search style", "/memory show preference", "/exit"]);
    let modelCalls = 0;
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        modelCalls += 1;
        return appendResult(task, history);
      },
    };
    await runRepl({
      agent,
      io,
      memory: {
        async list() {
          return [{
            id: "preference",
            title: "Response Style",
            tags: ["style"],
            updated: "2026-08-19T00:00:00.000Z",
            path: ".memory/preference.md",
          }];
        },
        async search() {
          return [{
            id: "preference",
            title: "Response Style",
            tags: ["style"],
            updated: "2026-08-19T00:00:00.000Z",
            path: ".memory/preference.md",
            score: 10,
            snippet: "Be concise.",
          }];
        },
        async read() {
          return {
            id: "preference",
            title: "Response Style",
            tags: ["style"],
            updated: "2026-08-19T00:00:00.000Z",
            path: ".memory/preference.md",
            content: "Be concise.",
          };
        },
      },
    });

    expect(modelCalls).toBe(0);
    expect(io.output.some((line) => line.includes("preference\tResponse Style"))).toBeTrue();
    expect(io.output.some((line) => line.includes("preference\t10.00"))).toBeTrue();
    expect(io.output).toContain("# Response Style\n\nBe concise.");
  });

  test("lists models, switches by number, and uses the new model on the next turn", async () => {
    const io = scriptedIO(["/models", "2", "/status", "hello", "/exit"]);
    let currentModel = "agnes-2.5-flash";
    const selected: string[] = [];
    const modelSeenByAgent: string[] = [];
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        modelSeenByAgent.push(currentModel);
        return appendResult(task, history);
      },
    };

    await runRepl({
      agent,
      io,
      sessionId: "demo",
      models: {
        get currentModel() {
          return currentModel;
        },
        async listModels() {
          return [{ id: "agnes-2.5-flash" }, { id: "agnes-2.5-pro" }];
        },
        selectModel(id) {
          currentModel = id;
        },
      },
      onModelChanged(model) {
        selected.push(model);
      },
    });

    expect(io.output).toContain("1. agnes-2.5-flash *");
    expect(io.output).toContain("2. agnes-2.5-pro");
    expect(io.output).toContain("Switched model to agnes-2.5-pro.");
    expect(io.output).toContain("session: demo · model: agnes-2.5-pro · state: idle · messages: 0");
    expect(selected).toEqual(["agnes-2.5-pro"]);
    expect(modelSeenByAgent).toEqual(["agnes-2.5-pro"]);
  });

  test("uses an interactive picker when the TUI provides one", async () => {
    const io = scriptedIO(["/models", "hello", "/exit"]);
    let pickerTitle = "";
    let currentModel = "agnes-2.5-flash";
    io.select = async (options) => {
      pickerTitle = options.title;
      expect(options.selectedValue).toBe("agnes-2.5-flash");
      expect(options.items.map((item) => item.value)).toEqual(["agnes-2.5-flash", "agnes-2.5-pro"]);
      return "agnes-2.5-pro";
    };
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        expect(currentModel).toBe("agnes-2.5-pro");
        return appendResult(task, history);
      },
    };

    await runRepl({
      agent,
      io,
      models: {
        get currentModel() {
          return currentModel;
        },
        async listModels() {
          return [{ id: "agnes-2.5-flash" }, { id: "agnes-2.5-pro" }];
        },
        selectModel(id) {
          currentModel = id;
        },
      },
    });

    expect(pickerTitle).toBe("Select model");
    expect(io.output).not.toContain("Available models · current: agnes-2.5-flash");
    expect(io.output).not.toContain("Switched model to agnes-2.5-pro.");
  });

  test("preserves the picker method receiver", async () => {
    const io = scriptedIO(["/models", "/exit"]);
    let receiverPreserved = false;
    io.select = async function () {
      receiverPreserved = this === io;
      return null;
    };
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };

    await runRepl({
      agent,
      io,
      models: {
        currentModel: "agnes-2.5-flash",
        async listModels() {
          return [{ id: "agnes-2.5-flash" }];
        },
        selectModel() {},
      },
    });

    expect(receiverPreserved).toBeTrue();
  });

  test("only refreshes the provider catalog for /models refresh", async () => {
    const io = scriptedIO(["/models", "/models refresh", "/exit"]);
    io.select = async () => null;
    let cachedReads = 0;
    let refreshes = 0;
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };
    const catalog = [{ id: "agnes-2.5-flash" }];

    await runRepl({
      agent,
      io,
      models: {
        currentModel: "agnes-2.5-flash",
        async listModels() {
          cachedReads += 1;
          return catalog;
        },
        async refreshModels() {
          refreshes += 1;
          return catalog;
        },
        selectModel() {},
      },
    });

    expect(cachedReads).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("switches between configured providers without changing their model catalogs", async () => {
    const io = scriptedIO(["/provider", "/provider minimax", "/status", "/provider agnes", "/exit"]);
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };
    let currentProvider: "agnes" | "minimax" = "agnes";
    const models = {
      currentModel: "agnes-2.5-flash",
      get currentProvider() {
        return currentProvider;
      },
      availableProviders: () => ["agnes", "minimax"] as const,
      selectProvider(provider: "agnes" | "minimax") {
        currentProvider = provider;
        this.currentModel = provider === "agnes" ? "agnes-2.5-flash" : "MiniMax-M2.7";
      },
      async listModels() {
        return [{ id: this.currentModel }];
      },
      selectModel() {},
    };

    await runRepl({ agent, io, models });

    expect(io.output).toContain("agnes *");
    expect(io.output).toContain("Switched provider to minimax · model: MiniMax-M2.7.");
    expect(io.output.some((line) => line.includes("session: memory-only · model: minimax/MiniMax-M2.7"))).toBeTrue();
  });

  test("keeps the current model after cancellation, invalid input, or list failure", async () => {
    const cancelled = scriptedIO(["/models", "", "/models", "99", "/exit"]);
    let selections = 0;
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };
    const models = {
      currentModel: "agnes-2.5-flash",
      async listModels() {
        return [{ id: "agnes-2.5-flash" }];
      },
      selectModel() {
        selections += 1;
      },
    };

    await runRepl({ agent, io: cancelled, models });

    expect(selections).toBe(0);
    expect(cancelled.output).toContain("Model selection cancelled.");
    expect(cancelled.errors).toContain("Invalid model selection: 99");

    const failed = scriptedIO(["/models", "/exit"]);
    await runRepl({
      agent,
      io: failed,
      models: {
        currentModel: "agnes-2.5-flash",
        async listModels() {
          throw new Error("catalog unavailable");
        },
        selectModel() {},
      },
    });
    expect(failed.errors).toContain("[error] catalog unavailable");
  });

  test("cancels an active model-list request without exiting the REPL", async () => {
    let interrupt: (() => void) | undefined;
    const io = scriptedIO(["/models", "/exit"]);
    io.onInterrupt = (handler) => {
      interrupt = handler;
    };
    const agent: ReplAgent = {
      async runWithHistory(task, history = []) {
        return appendResult(task, history);
      },
    };

    await runRepl({
      agent,
      io,
      models: {
        currentModel: "agnes-2.5-flash",
        async listModels(signal) {
          setTimeout(() => interrupt?.(), 0);
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new OperationCancelledError()),
              { once: true },
            );
          });
        },
        selectModel() {},
      },
    });

    expect(io.errors).toContain("Cancelling current turn...");
    expect(io.output).toContain("Model listing cancelled.");
    expect(io.output).toContain("REPL closed.");
  });
});

describe("resolveModelSelection", () => {
  const models = [{ id: "agnes-2.5-flash" }, { id: "agnes-2.5-pro" }];

  test("accepts a one-based index or exact model id", () => {
    expect(resolveModelSelection("1", models)).toBe("agnes-2.5-flash");
    expect(resolveModelSelection("agnes-2.5-pro", models)).toBe("agnes-2.5-pro");
  });

  test("rejects zero, out-of-range indexes, and partial ids", () => {
    expect(resolveModelSelection("0", models)).toBeUndefined();
    expect(resolveModelSelection("3", models)).toBeUndefined();
    expect(resolveModelSelection("agnes-2.5", models)).toBeUndefined();
  });
});
