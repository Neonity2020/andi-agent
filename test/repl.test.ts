import { describe, expect, test } from "bun:test";
import type { AgentRunResult } from "../src/agent";
import type { Message } from "../src/model/types";
import { runRepl, type ReplAgent, type ReplIO } from "../src/repl";
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
    expect(io.output).toContain("session: demo · state: idle · messages: 1");
    expect(io.output).toContain("session: demo · state: idle · messages: 0");
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
});
