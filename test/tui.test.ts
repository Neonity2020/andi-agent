import { describe, expect, test } from "bun:test";
import { Tui, type TuiStdin } from "../src/tui/tui";

class FakeStdin implements TuiStdin {
  readonly #listeners: Array<(chunk: Uint8Array) => void> = [];
  readonly #closeListeners: Array<() => void> = [];
  rawMode: boolean[] = [];
  paused = false;

  on(event: "data" | "close", listener: never): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "data" | "close", listener: ((chunk: Uint8Array) => void) | (() => void)): void {
    if (event === "data") this.#listeners.push(listener as (chunk: Uint8Array) => void);
    else this.#closeListeners.push(listener as () => void);
  }

  setRawMode(mode: boolean): void {
    this.rawMode.push(mode);
  }

  resume(): void {}

  pause(): void {
    this.paused = true;
  }

  send(text: string): void {
    const chunk = new TextEncoder().encode(text);
    for (const listener of [...this.#listeners]) listener(chunk);
  }

  end(): void {
    for (const listener of [...this.#closeListeners]) listener();
  }
}

interface Harness {
  tui: Tui;
  stdin: FakeStdin;
  output: () => string;
  raw: () => string;
  advance: (ms: number) => void;
}

function createHarness(): Harness {
  const stdin = new FakeStdin();
  const chunks: string[] = [];
  let clock = 0;
  const tui = new Tui({
    stdin,
    sink: { write: (data) => chunks.push(data) },
    columns: () => 60,
    status: { model: "agnes-2.5-flash", session: "test", cwd: "/tmp/ws" },
    colorEnabled: false,
    animate: false,
    now: () => clock,
  });
  return {
    tui,
    stdin,
    output: () => chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, ""),
    raw: () => chunks.join(""),
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe("Tui", () => {
  test("edits input and resolves read on submit", async () => {
    const { tui, stdin, output } = createHarness();
    tui.start();
    const pending = tui.read("you> ");
    stdin.send("hello worl");
    stdin.send("\x7f");
    stdin.send("ld");
    expect(output()).toContain("❯ hello world");
    stdin.send("\r");
    await expect(pending).resolves.toBe("hello world");
    expect(output()).toContain("❯ hello world");
  });

  test("renders agent turns, tools, and completion into scrollback", async () => {
    const { tui, stdin, output, advance } = createHarness();
    tui.start();
    const pending = tui.read("you> ");
    stdin.send("分析项目\r");
    await pending;
    tui.beginRun();

    tui.handleAgentEvent({ type: "turn_started", runId: "r", turn: 1, messageCount: 2 });
    advance(120);
    tui.handleAgentEvent({ type: "model_text_delta", runId: "r", turn: 1, delta: "查看 **关键** 文件" });
    tui.handleAgentEvent({
      type: "tool_started",
      runId: "r",
      turn: 1,
      toolCallId: "t1",
      toolName: "read_file",
    });
    tui.handleAgentEvent({
      type: "model_completed",
      runId: "r",
      turn: 1,
      toolCallCount: 1,
      durationMs: 500,
    });
    tui.handleAgentEvent({
      type: "tool_completed",
      runId: "r",
      turn: 1,
      toolCallId: "t1",
      toolName: "read_file",
      ok: true,
      durationMs: 100,
    });
    tui.handleAgentEvent({ type: "agent_completed", runId: "r", turns: 1 });

    const text = output();
    expect(text).toContain("❯ 分析项目");
    expect(text).toContain("查看 关键 文件");
    expect(text).toContain("✓ read_file · 100ms");
    expect(text).toContain("done → 1 turn(s)");
    expect(text).toContain("agnes-2.5-flash · test · /tmp/ws");
  });

  test("seals result output when the provider never streamed", async () => {
    const { tui, stdin } = createHarness();
    tui.start();
    const pending = tui.read("you> ");
    stdin.send("task\r");
    await pending;
    tui.beginRun();
    tui.handleAgentEvent({ type: "turn_started", runId: "r", turn: 1, messageCount: 2 });
    tui.handleAgentEvent({
      type: "model_completed",
      runId: "r",
      turn: 1,
      toolCallCount: 0,
      durationMs: 10,
    });
    tui.handleResult({ output: "final answer", messages: [], runId: "r", usage: null as never });
  });

  test("collapses MiniMax think tags and renders only the answer", () => {
    const { tui, output } = createHarness();
    tui.start();
    tui.beginRun();
    tui.handleAgentEvent({ type: "turn_started", runId: "r", turn: 1, messageCount: 2 });
    tui.handleAgentEvent({ type: "model_text_delta", runId: "r", turn: 1, delta: "<think>private reasoning</think>visible answer" });
    tui.handleAgentEvent({ type: "model_completed", runId: "r", turn: 1, toolCallCount: 0, durationMs: 10 });

    expect(output()).toContain("thinking (collapsed)");
    expect(output()).toContain("visible answer");
    expect(output()).not.toContain("private reasoning");
    expect(output()).not.toContain("<think>");
  });

  test("seals cancelled tools and a cancellation notice", async () => {
    const { tui, stdin, output } = createHarness();
    tui.start();
    const pending = tui.read("you> ");
    stdin.send("task\r");
    await pending;
    tui.beginRun();
    tui.handleAgentEvent({ type: "turn_started", runId: "r", turn: 1, messageCount: 2 });
    tui.handleAgentEvent({ type: "tool_started", runId: "r", turn: 1, toolCallId: "t1", toolName: "run_command" });
    tui.handleAgentEvent({ type: "agent_cancelled", runId: "r" });
    expect(output()).toContain("· run_command cancelled");
    expect(output()).toContain("turn cancelled");
  });

  test("shows memory recall metadata without exposing memory content", () => {
    const { tui, output } = createHarness();
    tui.start();
    tui.beginRun();
    tui.handleAgentEvent({
      type: "memory_context_loaded",
      runId: "r",
      ids: ["style", "architecture"],
      chars: 800,
      truncated: true,
    });
    expect(output()).toContain("memory · 2 note(s) (truncated)");
    expect(output()).not.toContain("architecture decision body");
  });

  test("updates the model shown in the status bar", () => {
    const { tui, output } = createHarness();
    tui.start();

    tui.setModel("agnes-2.5-pro");

    expect(output()).toContain("agnes-2.5-pro · test · /tmp/ws");
  });

  test("opens a searchable model picker and selects with the keyboard", async () => {
    const { tui, stdin, output } = createHarness();
    tui.start();
    const pending = tui.select({
      title: "Select model",
      selectedValue: "agnes-2.5-flash",
      items: [
        { value: "agnes-2.5-flash", label: "agnes-2.5-flash" },
        { value: "agnes-2.5-pro", label: "agnes-2.5-pro" },
      ],
    });

    expect(output()).toContain("Select model");
    expect(output()).toContain("agnes-2.5-flash ✓");
    stdin.send("pro");
    expect(output()).toContain("❯ pro");
    stdin.send("\r");

    await expect(pending).resolves.toBe("agnes-2.5-pro");
  });

  test("navigates the model picker with arrow keys", async () => {
    const { tui, stdin } = createHarness();
    tui.start();
    const pending = tui.select({
      title: "Select model",
      selectedValue: "agnes-2.5-flash",
      items: [
        { value: "agnes-2.5-flash", label: "agnes-2.5-flash" },
        { value: "agnes-2.5-pro", label: "agnes-2.5-pro" },
      ],
    });

    stdin.send("\x1b[B");
    stdin.send("\r");

    await expect(pending).resolves.toBe("agnes-2.5-pro");
  });

  test("cancels the model picker with escape", async () => {
    const { tui, stdin } = createHarness();
    tui.start();
    const pending = tui.select({
      title: "Select model",
      items: [{ value: "agnes-2.5-flash", label: "agnes-2.5-flash" }],
    });

    stdin.send("\x1b");

    await Bun.sleep(30);
    await expect(pending).resolves.toBeNull();
  });

  test("routes approval keys with y/N semantics", async () => {
    const { tui, stdin, output } = createHarness();
    tui.start();
    const approved = tui.approve(["bun", "install"]);
    expect(output()).toContain("approval required → bun install");
    expect(output()).toContain("approve? [y/N]");
    stdin.send("y");
    await expect(approved).resolves.toBe(true);

    const denied = tui.approve(["rm", "-rf", "docs"]);
    stdin.send("\r");
    await expect(denied).resolves.toBe(false);
  });

  test("denies approval when the abort signal fires", async () => {
    const { tui } = createHarness();
    tui.start();
    const controller = new AbortController();
    const pending = tui.approve(["bun", "install"], controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe(false);
  });

  test("positions the real cursor on the input line, above the status bar", () => {
    const { tui, stdin, raw } = createHarness();
    tui.start();
    void tui.read("you> ");
    stdin.send("ab");
    // Two lines up from below the region (over the status bar) onto the
    // input line, then to the column just after the typed text.
    expect(raw()).toMatch(/\x1b\[2A\x1b\[\d+G\x1b\[\?25h/);
  });

  test("keystrokes never lift the repaint into scrollback", () => {
    const { tui, stdin, raw } = createHarness();
    tui.start();
    void tui.read("you> ");
    stdin.send("abc");
    stdin.send("\x7f");
    // A full-region lift ("\x1b[2A\r") from the positioned cursor would
    // erase sealed lines above the region — the eat-a-line bug.
    expect(raw()).not.toContain("\x1b[2A\r");
  });

  test("left/right arrows reposition the real cursor even when the frame text is unchanged", () => {
    const { tui, stdin, raw } = createHarness();
    tui.start();
    void tui.read("you> ");
    const cursorColumn = () => {
      // The last ANSI cursor-to-column placement for the input line is the
      // one right after the "\x1b[2A" lift that ends the region paint.
      const matches = [...raw().matchAll(/\x1b\[2A\x1b\[(\d+)G/g)];
      return matches.length === 0 ? undefined : Number(matches.at(-1)![1]);
    };

    stdin.send("abc");
    const afterTyping = cursorColumn();

    stdin.send("\x1b[D"); // left
    const afterLeft = cursorColumn();

    stdin.send("\x1b[C"); // right
    const afterRight = cursorColumn();

    // Cursor starts just after "abc", moves one cell left, then back right.
    expect(afterTyping).toBe(afterRight);
    expect(afterLeft).toBe((afterTyping ?? 0) - 1);
  });

  test("forwards interrupts while running to the repl handler", async () => {
    const { tui, stdin } = createHarness();
    tui.start();
    let interrupted = 0;
    tui.onInterrupt(() => {
      interrupted += 1;
    });
    void tui.read("you> ");
    tui.beginRun();
    stdin.send("\x03");
    expect(interrupted).toBe(1);
  });

  test("uses ctrl-d as a global exit even when input contains a draft", async () => {
    const { tui, stdin } = createHarness();
    let exits = 0;
    tui.onExit(() => {
      exits += 1;
      tui.close();
    });
    tui.start();
    const pending = tui.read("you> ");
    stdin.send("unfinished draft");

    stdin.send("\x04");

    expect(exits).toBe(1);
    await expect(pending).resolves.toBeNull();
  });

  test("uses ctrl-d as a global exit while a model picker is open", async () => {
    const { tui, stdin } = createHarness();
    tui.onExit(() => tui.close());
    tui.start();
    const pending = tui.select({
      title: "Select model",
      items: [{ value: "agnes-2.5-flash", label: "agnes-2.5-flash" }],
    });

    stdin.send("\x04");

    await expect(pending).resolves.toBeNull();
  });

  test("close restores the terminal and unblocks pending reads", async () => {
    const { tui, stdin } = createHarness();
    tui.start();
    expect(stdin.rawMode[0]).toBe(true);
    const pending = tui.read("you> ");
    tui.close();
    await expect(pending).resolves.toBeNull();
    expect(stdin.rawMode.at(-1)).toBe(false);
    expect(stdin.paused).toBeTrue();
  });

  test("ends the session when stdin closes", async () => {
    const { tui, stdin, output } = createHarness();
    tui.start();
    const pending = tui.read("you> ");
    stdin.end();
    await expect(pending).resolves.toBeNull();
    expect(output()).toContain("agnes-2.5-flash");
    expect(stdin.rawMode.at(-1)).toBe(false);
  });
});
