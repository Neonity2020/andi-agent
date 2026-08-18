// The TUI orchestrator. Implements ReplIO so the existing runRepl loop,
// slash commands, and session persistence drive it unchanged. Finished units
// (assistant text, tool rows) are sealed into scrollback; the bottom managed
// region shows only in-flight work plus the input line and status bar.

import type { AgentEvent } from "../agent";
import type { AgentRunResult } from "../agent";
import { ActivityState, renderCancelledTool, renderSealedTool, renderUserEcho } from "./activity";
import {
  cursorToColumn,
  cursorUp,
  disableBracketedPaste,
  enableBracketedPaste,
  hideCursor,
  showCursor,
} from "./ansi";
import { InputDecoder, LineEditor, type KeyEvent } from "./input";
import { renderMarkdown } from "./markdown";
import { InlineScreen, type ScreenSink } from "./screen";
import { createTheme, type Theme } from "./theme";
import { textWidth, graphemes } from "./width";

export interface TuiStdin {
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "close", listener: () => void): void;
  setRawMode(mode: boolean): void;
  resume(): void;
}

export interface TuiStatus {
  model: string;
  session: string;
  cwd: string;
}

export interface TuiOptions {
  stdin: TuiStdin;
  sink: ScreenSink;
  columns: () => number;
  status: TuiStatus;
  colorEnabled?: boolean;
  now?: () => number;
  animate?: boolean;
  history?: readonly string[];
}

type Mode = "input" | "running" | "approval";

interface ReadWaiter {
  resolve: (line: string | null) => void;
}

interface ApprovalRequest {
  command: readonly string[];
  resolve: (approved: boolean) => void;
}

const PAINT_COALESCE_MS = 16;
const SPINNER_MS = 90;

export class Tui {
  readonly #stdin: TuiStdin;
  readonly #sink: ScreenSink;
  readonly #screen: InlineScreen;
  readonly #decoder = new InputDecoder();
  readonly #editor: LineEditor;
  readonly #activity = new ActivityState();
  readonly #theme: Theme;
  readonly #columns: () => number;
  readonly #status: TuiStatus;
  readonly #now: () => number;
  readonly #animate: boolean;

  #mode: Mode = "input";
  #waiters: ReadWaiter[] = [];
  #approval: ApprovalRequest | undefined;
  #interruptHandler: (() => void) | undefined;
  #turnSealedOutput = true;
  #spinnerTimer: ReturnType<typeof setInterval> | undefined;
  #paintQueued = false;
  #closed = false;
  #lastFrame: string[] | null = null;

  constructor(options: TuiOptions) {
    this.#stdin = options.stdin;
    this.#sink = options.sink;
    this.#screen = new InlineScreen({ sink: options.sink, columns: options.columns });
    this.#editor = new LineEditor(options.history);
    this.#theme = createTheme(options.colorEnabled ?? false);
    this.#columns = options.columns;
    this.#status = options.status;
    this.#now = options.now ?? (() => Date.now());
    this.#animate = options.animate ?? true;
  }

  start(): void {
    this.#stdin.setRawMode(true);
    this.#stdin.resume();
    this.#stdin.on("data", (chunk) => this.#onData(chunk));
    // A closed stdin (pty EOF, terminal exit) ends the session like ^D.
    this.#stdin.on("close", () => {
      if (!this.#closed) this.close();
    });
    this.#write(enableBracketedPaste());
    if (this.#animate) {
      this.#spinnerTimer = setInterval(() => this.#schedulePaint(), SPINNER_MS);
    }
    this.#paint();
  }

  // ---- ReplIO ----

  read(_prompt: string): Promise<string | null> {
    if (this.#closed) return Promise.resolve(null);
    this.#mode = "input";
    this.#schedulePaint();
    return new Promise((resolve) => {
      this.#waiters.push({ resolve });
    });
  }

  write(message: string): void {
    this.#seal(message.split("\n"));
  }

  error(message: string): void {
    this.#seal(message.split("\n").map((line) => this.#theme.errorText(line)));
  }

  onInterrupt(handler: () => void): void {
    this.#interruptHandler = handler;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#spinnerTimer) clearInterval(this.#spinnerTimer);
    this.#screen.dispose();
    this.#write(`${showCursor()}${disableBracketedPaste()}`);
    try {
      this.#stdin.setRawMode(false);
    } catch {
      // stdin may already be destroyed during shutdown
    }
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(null);
    if (this.#approval) {
      this.#approval.resolve(false);
      this.#approval = undefined;
    }
  }

  // ---- Agent events ----

  handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
    case "turn_started":
      this.#turnSealedOutput = false;
      this.#activity.beginTurn(this.#now());
      break;
    case "model_text_delta":
      this.#activity.appendDelta(event.delta);
      break;
    case "model_completed": {
      const stream = this.#activity.takeStream();
      if (stream.trim().length > 0) {
        this.#seal(renderMarkdown(stream.trim(), this.#width(), this.#theme));
        this.#turnSealedOutput = true;
      }
      break;
    }
    case "tool_started":
      this.#activity.toolStarted(event.toolCallId, event.toolName, this.#now());
      break;
    case "tool_completed":
      this.#activity.toolEnded(event.toolCallId);
      this.#seal([renderSealedTool(event.toolName, event.ok, event.durationMs, this.#theme)]);
      break;
    case "context_compacted":
      this.#seal([this.#theme.style.dim(`context compacted ${this.#theme.symbols.dot} dropped ${event.droppedMessages} message(s)`)]);
      break;
    case "agent_completed":
      this.#seal([this.#theme.style.dim(`done ${this.#theme.symbols.arrow} ${event.turns} turn(s)`)]);
      this.#activity.endTurn();
      this.#mode = "input";
      break;
    case "agent_cancelled": {
      const leftover = this.#activity.takeStream();
      if (leftover.trim().length > 0) this.#seal([this.#theme.style.dim(leftover.trim())]);
      for (const tool of this.#activity.drainTools()) {
        this.#seal([renderCancelledTool(tool.name, this.#theme)]);
      }
      this.#seal([this.#theme.style.dim("turn cancelled")]);
      this.#activity.endTurn();
      this.#mode = "input";
      break;
    }
    case "agent_failed":
      this.#seal([this.#theme.errorText(`failed ${this.#theme.symbols.dot} ${event.error}`)]);
      this.#activity.endTurn();
      this.#mode = "input";
      break;
    }
    this.#schedulePaint();
  }

  // Called from runRepl's onResult: seals the final output when streaming
  // events never carried it (non-streaming providers).
  handleResult(result: AgentRunResult): void {
    if (this.#turnSealedOutput) return;
    this.#turnSealedOutput = true;
    const output = result.output.trim();
    if (output.length > 0) this.#seal(renderMarkdown(output, this.#width(), this.#theme));
  }

  // Marks the turn as running (input disabled until the turn finishes).
  beginRun(): void {
    this.#mode = "running";
    this.#schedulePaint();
  }

  // ---- Approval (CommandApprover adapter) ----

  approve = (command: readonly string[], signal?: AbortSignal): Promise<boolean> => {
    if (this.#closed) return Promise.resolve(false);
    const label = command.join(" ");
    this.#seal([
      this.#theme.warnText(`approval required ${this.#theme.symbols.arrow} ${label}`),
      "",
    ]);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.#approval = undefined;
        this.#mode = "running";
        this.#schedulePaint();
        resolve(approved);
      };
      const onAbort = (): void => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#approval = { command, resolve: finish };
      this.#mode = "approval";
      this.#schedulePaint();
    });
  };

  // ---- Input ----

  #onData(chunk: Uint8Array): void {
    for (const event of this.#decoder.push(chunk)) this.#onKey(event);
  }

  #onKey(event: KeyEvent): void {
    if (this.#closed) return;

    if (this.#mode === "approval" && this.#approval) {
      // y approves; any other key (including enter) denies, matching the
      // [y/N] default of the plain approver.
      if (event.key === "interrupt") this.#interruptHandler?.();
      const approved = event.key === "text" && (event.text === "y" || event.text === "Y");
      this.#approval.resolve(approved);
      return;
    }

    if (this.#mode === "running") {
      if (event.key === "interrupt") this.#interruptHandler?.();
      return;
    }

    const action = this.#editor.handleKey(event);
    switch (action.type) {
    case "submitted": {
      const line = action.line;
      if (line.trim().length > 0) this.#seal(renderUserEcho(line, this.#width(), this.#theme));
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.#mode = "running";
      this.#schedulePaint();
      return;
    }
    case "interrupt":
      this.#interruptHandler?.();
      return;
    case "eof":
      this.#interruptHandler?.();
      return;
    case "escape":
      return;
    case "changed":
    case "none":
    default:
      this.#schedulePaint();
    }
  }

  // ---- Rendering ----

  #width(): number {
    return Math.max(this.#columns(), 20);
  }

  #schedulePaint(): void {
    if (this.#closed) return;
    if (!this.#animate) {
      this.#paint();
      return;
    }
    if (this.#paintQueued) return;
    this.#paintQueued = true;
    setTimeout(() => {
      this.#paintQueued = false;
      this.#paint();
    }, PAINT_COALESCE_MS);
  }

  #paint(): void {
    if (this.#closed) return;
    const width = this.#width();
    const lines: string[] = [];

    if (this.#mode !== "approval") {
      lines.push(...this.#activity.render(this.#now(), width, this.#theme));
    }

    if (this.#mode === "approval") {
      lines.push(this.#theme.warnText("approve? [y/N]"));
    } else if (this.#mode === "running") {
      lines.push(this.#theme.style.dim("ctrl-c to cancel"));
    } else {
      lines.push(this.#inputLine(width));
    }

    lines.push(this.#statusLine(width));

    // The spinner timer repaints constantly; skip writes when nothing
    // changed (idle) so the terminal is untouched between keystrokes.
    if (this.#lastFrame !== null && this.#framesEqual(this.#lastFrame, lines)) return;
    this.#lastFrame = lines;
    this.#screen.render(lines);

    if (this.#mode === "input") {
      const prefixWidth = textWidth(this.#theme.symbols.prompt) + 1;
      const cursorWidth = textWidth(this.#editor.getClusters().slice(0, this.#editor.getCursor()).join(""));
      const budget = Math.max(width - prefixWidth, 1);
      const scroll = Math.max(0, cursorWidth - budget + 1);
      const column = Math.max(prefixWidth + cursorWidth - scroll + 1, 1);
      this.#write(`${cursorUp(1)}${cursorToColumn(column)}${showCursor()}`);
    } else {
      this.#write(hideCursor());
    }
  }

  #inputLine(width: number): string {
    const prefix = `${this.#theme.brandText(this.#theme.symbols.prompt)} `;
    const prefixWidth = textWidth(this.#theme.symbols.prompt) + 1;
    const budget = Math.max(width - prefixWidth, 4);
    const text = this.#editor.getText();
    if (textWidth(text) <= budget) return prefix + text;
    // Horizontal scroll: keep a window that ends at the cursor visible.
    const cursorWidth = textWidth(this.#editor.getClusters().slice(0, this.#editor.getCursor()).join(""));
    const scroll = Math.max(0, cursorWidth - budget + 1);
    return prefix + sliceByCells(text, scroll, budget);
  }

  #statusLine(width: number): string {
    const parts = [this.#status.model, this.#status.session, this.#status.cwd];
    const line = parts.join(` ${this.#theme.symbols.dot} `);
    return this.#theme.style.dim(` ${line}`);
  }

  #seal(lines: readonly string[]): void {
    if (this.#closed) return;
    // Printing repaints the region without repositioning the cursor; force
    // the next paint to rewrite it.
    this.#lastFrame = null;
    this.#screen.print(lines.length > 0 ? [...lines, ""] : []);
  }

  #framesEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  #write(data: string): void {
    if (data.length > 0) this.#sink.write(data);
  }
}

function sliceByCells(text: string, startCell: number, widthCells: number): string {
  let cell = 0;
  let output = "";
  for (const cluster of graphemes(text)) {
    const clusterWidth = textWidth(cluster);
    if (cell + clusterWidth <= startCell) {
      cell += clusterWidth;
      continue;
    }
    if (cell + clusterWidth > startCell + widthCells) break;
    output += cluster;
    cell += clusterWidth;
  }
  return output;
}
