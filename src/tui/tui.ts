// The TUI orchestrator. Implements ReplIO so the existing runRepl loop,
// slash commands, and session persistence drive it unchanged. Finished units
// (assistant text, tool rows) are sealed into scrollback; the bottom managed
// region shows only in-flight work plus the input line and status bar.

import type { AgentEvent } from "../agent";
import type { AgentRunResult } from "../agent";
import type { ReplSelectItem, ReplSelectOptions } from "../repl";
import { ActivityState, parseThinkTags, renderCancelledTool, renderSealedTool, renderUserEcho } from "./activity";
import {
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
  pause?(): void;
}

export interface TuiStatus {
  model: string;
  session: string;
  cwd: string;
}

export interface TuiCommandHint {
  name: string;
  description: string;
}

export interface TuiOptions {
  stdin: TuiStdin;
  sink: ScreenSink;
  columns: () => number;
  rows?: () => number;
  status: TuiStatus;
  colorEnabled?: boolean;
  now?: () => number;
  animate?: boolean;
  history?: readonly string[];
  commands?: readonly TuiCommandHint[];
}

type Mode = "input" | "running" | "approval" | "select";

interface ReadWaiter {
  resolve: (line: string | null) => void;
}

interface ApprovalRequest {
  command: readonly string[];
  resolve: (approved: boolean) => void;
}

interface SelectRequest {
  title: string;
  items: readonly ReplSelectItem[];
  currentValue: string | undefined;
  query: string;
  selectedIndex: number;
  resolve: (value: string | null) => void;
}

const PAINT_COALESCE_MS = 16;
const SPINNER_MS = 90;
const ESCAPE_DELAY_MS = 25;
const SELECT_PAGE_SIZE = 8;
const COMPLETION_PAGE_SIZE = 8;
const COMPLETION_MIN_HEIGHT = 6;

interface CursorCell {
  row: number;
  column: number;
}

interface CompletionState {
  selectedIndex: number;
  dismissed: boolean;
}

export class Tui {
  readonly #stdin: TuiStdin;
  readonly #sink: ScreenSink;
  readonly #screen: InlineScreen;
  readonly #decoder = new InputDecoder();
  readonly #editor: LineEditor;
  readonly #activity = new ActivityState();
  readonly #theme: Theme;
  readonly #columns: () => number;
  readonly #rows: () => number;
  readonly #commands: readonly TuiCommandHint[];
  readonly #status: TuiStatus;
  readonly #now: () => number;
  readonly #animate: boolean;

  #mode: Mode = "input";
  #waiters: ReadWaiter[] = [];
  #approval: ApprovalRequest | undefined;
  #selection: SelectRequest | undefined;
  #completion: CompletionState = { selectedIndex: 0, dismissed: false };
  #interruptHandler: (() => void) | undefined;
  #exitHandler: (() => void) | undefined;
  #turnSealedOutput = true;
  #spinnerTimer: ReturnType<typeof setInterval> | undefined;
  #escapeTimer: ReturnType<typeof setTimeout> | undefined;
  #paintQueued = false;
  #closed = false;
  #lastFrame: string[] | null = null;
  #lastCursorCell: CursorCell | undefined;

  constructor(options: TuiOptions) {
    this.#stdin = options.stdin;
    this.#sink = options.sink;
    this.#screen = new InlineScreen({ sink: options.sink, columns: options.columns });
    this.#editor = new LineEditor(options.history);
    this.#theme = createTheme(options.colorEnabled ?? false);
    this.#columns = options.columns;
    this.#rows = options.rows ?? (() => 24);
    this.#commands = [...(options.commands ?? [])];
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

  select(options: ReplSelectOptions): Promise<string | null> {
    if (this.#closed || options.items.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const selectedIndex = Math.max(
        options.items.findIndex((item) => item.value === options.selectedValue),
        0,
      );
      this.#selection = {
        title: options.title,
        items: options.items,
        currentValue: options.selectedValue,
        query: "",
        selectedIndex,
        resolve,
      };
      this.#mode = "select";
      this.#schedulePaint();
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

  onExit(handler: () => void): void {
    this.#exitHandler = handler;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#spinnerTimer) clearInterval(this.#spinnerTimer);
    if (this.#escapeTimer) clearTimeout(this.#escapeTimer);
    this.#screen.dispose();
    this.#write(`${showCursor()}${disableBracketedPaste()}`);
    try {
      this.#stdin.setRawMode(false);
    } catch {
      // stdin may already be destroyed during shutdown
    }
    this.#stdin.pause?.();
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(null);
    if (this.#approval) {
      this.#approval.resolve(false);
      this.#approval = undefined;
    }
    if (this.#selection) {
      this.#selection.resolve(null);
      this.#selection = undefined;
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
      const thinking = this.#activity.takeThinking();
      const stream = this.#activity.takeStream();
      if (thinking.text.trim().length > 0 || thinking.open) {
        this.#seal([this.#theme.style.dim(`thinking (collapsed) ${this.#theme.symbols.dot} ${thinking.text.trim().length} chars`)]);
      }
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
    case "memory_context_loaded":
      this.#seal([
        this.#theme.style.dim(
          `memory ${this.#theme.symbols.dot} ${event.ids.length} note(s)${event.truncated ? " (truncated)" : ""}`,
        ),
      ]);
      break;
    case "memory_context_failed":
      this.#seal([this.#theme.warnText(`memory unavailable ${this.#theme.symbols.dot} ${event.error}`)]);
      break;
    case "agent_completed":
      this.#seal([this.#theme.style.dim(`done ${this.#theme.symbols.arrow} ${event.turns} turn(s)`)]);
      this.#activity.endTurn();
      this.#mode = "input";
      break;
    case "agent_cancelled": {
      const thinking = this.#activity.takeThinking();
      const leftover = this.#activity.takeStream();
      if (thinking.text.trim().length > 0 || thinking.open) {
        this.#seal([this.#theme.style.dim(`thinking (collapsed) ${this.#theme.symbols.dot} ${thinking.text.trim().length} chars`)]);
      }
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
    const parsed = parseThinkTags(result.output);
    if (parsed.thinking.trim().length > 0 || parsed.thinkingOpen) {
      this.#seal([this.#theme.style.dim(`thinking (collapsed) ${parsed.thinking.trim().length} chars`)]);
    }
    const output = parsed.content.trim();
    if (output.length > 0) this.#seal(renderMarkdown(output, this.#width(), this.#theme));
  }

  // Marks the turn as running (input disabled until the turn finishes).
  beginRun(): void {
    this.#mode = "running";
    this.#schedulePaint();
  }

  setModel(model: string): void {
    this.#status.model = model;
    this.#schedulePaint();
  }

  // ---- Approval (CommandApprover adapter) ----

  approve = (command: readonly string[], signal?: AbortSignal): Promise<boolean> => {
    if (this.#closed) return Promise.resolve(false);
    const label = command.join(" ");
    this.#seal([
      this.#theme.warnText(`需要批准 ${this.#theme.symbols.arrow} ${label}`),
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
    if (this.#escapeTimer) clearTimeout(this.#escapeTimer);
    for (const event of this.#decoder.push(chunk)) this.#onKey(event);
    this.#escapeTimer = setTimeout(() => {
      this.#escapeTimer = undefined;
      const event = this.#decoder.flushEscape();
      if (event) this.#onKey(event);
    }, ESCAPE_DELAY_MS);
  }

  #onKey(event: KeyEvent): void {
    if (this.#closed) return;
    if (event.key === "eof") {
      this.#exitHandler?.();
      return;
    }

    if (this.#mode === "approval" && this.#approval) {
      // y 批准；任意其他键（包括回车）拒绝，匹配纯文本审批器的 [y/N] 默认行为。
      if (event.key === "interrupt") this.#interruptHandler?.();
      const approved = event.key === "text" && (event.text === "y" || event.text === "Y");
      this.#approval.resolve(approved);
      return;
    }

    if (this.#mode === "running") {
      if (event.key === "interrupt") this.#interruptHandler?.();
      return;
    }

    if (this.#mode === "select" && this.#selection) {
      this.#handleSelectKey(event);
      return;
    }

    if (this.#mode === "input" && this.#completionActive() && this.#handleCompletionKey(event)) {
      this.#schedulePaint();
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
      this.#resetCompletion();
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
      // A changed draft restarts the completion lifecycle at the top entry.
      this.#completion.dismissed = false;
      this.#completion.selectedIndex = 0;
      this.#schedulePaint();
      return;
    case "none":
    default:
      this.#schedulePaint();
    }
  }

  #handleSelectKey(event: KeyEvent): void {
    const selection = this.#selection;
    if (!selection) return;
    const items = this.#filteredSelectionItems(selection);
    switch (event.key) {
    case "up":
      if (items.length > 0) selection.selectedIndex = (selection.selectedIndex - 1 + items.length) % items.length;
      break;
    case "down":
      if (items.length > 0) selection.selectedIndex = (selection.selectedIndex + 1) % items.length;
      break;
    case "pageup":
      selection.selectedIndex = Math.max(0, selection.selectedIndex - SELECT_PAGE_SIZE);
      break;
    case "pagedown":
      selection.selectedIndex = Math.min(Math.max(items.length - 1, 0), selection.selectedIndex + SELECT_PAGE_SIZE);
      break;
    case "home":
      selection.selectedIndex = 0;
      break;
    case "end":
      selection.selectedIndex = Math.max(items.length - 1, 0);
      break;
    case "text":
    case "paste":
      selection.query += event.text ?? "";
      selection.selectedIndex = 0;
      break;
    case "backspace": {
      const query = graphemes(selection.query);
      query.pop();
      selection.query = query.join("");
      selection.selectedIndex = 0;
      break;
    }
    case "killToStart":
    case "killLine":
      selection.query = "";
      selection.selectedIndex = 0;
      break;
    case "enter":
      this.#finishSelection(items[selection.selectedIndex]?.value ?? null);
      return;
    case "escape":
    case "interrupt":
      this.#finishSelection(null);
      return;
    default:
      break;
    }
    this.#schedulePaint();
  }

  #finishSelection(value: string | null): void {
    const selection = this.#selection;
    if (!selection) return;
    this.#selection = undefined;
    this.#mode = "input";
    this.#schedulePaint();
    selection.resolve(value);
  }

  // ---- Slash command completion ----

  // Active while the draft is a bare "/word" (no whitespace): the command
  // list floats above the input line and steals the navigation keys.
  #completionActive(): boolean {
    if (this.#commands.length === 0 || this.#completion.dismissed) return false;
    return /^\/\S*$/.test(this.#editor.getText());
  }

  #completionMatches(): readonly TuiCommandHint[] {
    const query = this.#editor.getText().slice(1).toLocaleLowerCase();
    const scored = this.#commands
      .map((command) => {
        const name = command.name.toLocaleLowerCase();
        const score = name.startsWith(`/${query}`)
          ? 2
          : name.slice(1).includes(query)
            ? 1
            : -1;
        return { command, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name));
    return scored.slice(0, COMPLETION_PAGE_SIZE).map((entry) => entry.command);
  }

  // Returns true when the event was consumed by the completion layer.
  #handleCompletionKey(event: KeyEvent): boolean {
    switch (event.key) {
    case "up": {
      const items = this.#completionMatches();
      if (items.length === 0) return false;
      this.#completion.selectedIndex = (this.#completion.selectedIndex - 1 + items.length) % items.length;
      return true;
    }
    case "down": {
      const items = this.#completionMatches();
      if (items.length === 0) return false;
      this.#completion.selectedIndex = (this.#completion.selectedIndex + 1) % items.length;
      return true;
    }
    case "tab": {
      const selected = this.#completionMatches()[this.#completion.selectedIndex];
      if (!selected) return false;
      this.#editor.setText(`${selected.name} `);
      this.#completion.dismissed = false;
      return true;
    }
    case "enter": {
      const text = this.#editor.getText();
      const exact = this.#commands.some((command) => command.name === text);
      if (exact) return false;
      const selected = this.#completionMatches()[this.#completion.selectedIndex];
      if (!selected) return false;
      this.#editor.setText(selected.name);
      const action = this.#editor.handleKey({ key: "enter" });
      if (action.type === "submitted") {
        const line = action.line;
        this.#seal(renderUserEcho(line, this.#width(), this.#theme));
        const waiter = this.#waiters.shift();
        if (waiter) waiter.resolve(line);
        else this.#mode = "running";
      }
      this.#resetCompletion();
      return true;
    }
    case "escape":
      this.#completion.dismissed = true;
      return true;
    default:
      return false;
    }
  }

  #resetCompletion(): void {
    this.#completion = { selectedIndex: 0, dismissed: false };
  }

  #filteredSelectionItems(selection: SelectRequest): readonly ReplSelectItem[] {
    const query = selection.query.trim().toLocaleLowerCase();
    if (query.length === 0) return selection.items;
    return selection.items.filter((item) =>
      `${item.label} ${item.description ?? ""}`.toLocaleLowerCase().includes(query),
    );
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
      lines.push(this.#theme.warnText("批准？[y/N]"));
    } else if (this.#mode === "select" && this.#selection) {
      lines.push(...this.#selectionLines(this.#selection, width));
    } else if (this.#mode === "running") {
      lines.push(this.#theme.style.dim("ctrl-c to cancel"));
    } else {
      lines.push(...this.#completionLines(width));
      lines.push(...this.#inputLines(width));
    }

    lines.push(this.#statusLine(width));

    // The cursor sits on the input line independent of the rendered frame, so
    // compute its target cell up front: a left/right arrow move changes the
    // cursor but leaves the frame text identical, and must still reposition it.
    const cursorCell = this.#mode === "input"
      ? this.#cursorCell(width)
      : undefined;

    // The spinner timer repaints constantly; skip writes when nothing
    // changed (idle) so the terminal is untouched between keystrokes. The
    // cursor cell is included so pure cursor moves are never dropped.
    if (this.#lastFrame !== null && this.#framesEqual(this.#lastFrame, lines) && this.#cursorCellsEqual(cursorCell, this.#lastCursorCell)) return;
    this.#lastFrame = lines;
    this.#lastCursorCell = cursorCell;
    this.#screen.render(lines);

    if (this.#mode === "input" && cursorCell !== undefined) {
      this.#screen.positionCursor(cursorCell.row, cursorCell.column);
      this.#write(showCursor());
    } else {
      this.#write(hideCursor());
    }
  }

  #cursorCellsEqual(left: CursorCell | undefined, right: CursorCell | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    return left.row === right.row && left.column === right.column;
  }

  // Cursor cell in InlineScreen coordinates (row counted from the region
  // bottom): one status line below the input area, then the visible input
  // rows between the cursor and the bottom of the scrolled editor.
  #cursorCell(width: number): CursorCell {
    const visible = this.#visibleInput();
    return { row: 2 + (visible.rows.length - 1 - visible.cursorRow), column: this.#cursorColumnInRow(width) };
  }

  #selectionLines(selection: SelectRequest, width: number): string[] {
    const items = this.#filteredSelectionItems(selection);
    const selectedIndex = Math.min(selection.selectedIndex, Math.max(items.length - 1, 0));
    const maxStart = Math.max(items.length - SELECT_PAGE_SIZE, 0);
    const start = Math.min(Math.max(selectedIndex - Math.floor(SELECT_PAGE_SIZE / 2), 0), maxStart);
    const visible = items.slice(start, start + SELECT_PAGE_SIZE);
    const lines = [this.#theme.style.bold(selection.title)];
    lines.push(
      selection.query.length > 0
        ? `${this.#theme.symbols.prompt} ${selection.query}`
        : this.#theme.style.dim("Type to filter models"),
    );
    if (visible.length === 0) {
      lines.push(this.#theme.style.dim("  No matching models"));
    } else {
      visible.forEach((item, offset) => {
        const index = start + offset;
        const marker = index === selectedIndex ? this.#theme.symbols.prompt : " ";
        const current = item.value === selection.currentValue ? ` ${this.#theme.symbols.check}` : "";
        const line = sliceByCells(`${marker} ${item.label}${current}`, 0, width);
        lines.push(index === selectedIndex ? this.#theme.brandText(line) : line);
      });
    }
    lines.push(this.#theme.style.dim("↑/↓ navigate · enter select · esc cancel"));
    return lines;
  }

  // The editor's visible slice: grows with content up to a third of the
  // terminal (minimum COMPLETION_MIN_HEIGHT lines), then scrolls to keep the
  // caret row on screen.
  #visibleInput(): { rows: string[]; cursorRow: number } {
    const lineCount = this.#editor.getLineCount();
    const rows = Array.from({ length: lineCount }, (_value, row) => this.#editor.getRowClusters(row).join(""));
    const maxHeight = Math.max(COMPLETION_MIN_HEIGHT, Math.floor(this.#rows() / 3));
    if (rows.length <= maxHeight) return { rows, cursorRow: this.#editor.getCursorRow() };
    const cursorRow = this.#editor.getCursorRow();
    const start = Math.min(Math.max(cursorRow - (maxHeight - 1), 0), rows.length - maxHeight);
    return { rows: rows.slice(start, start + maxHeight), cursorRow: cursorRow - start };
  }

  #inputLines(width: number): string[] {
    const prefix = `${this.#theme.brandText(this.#theme.symbols.prompt)} `;
    const prefixWidth = textWidth(this.#theme.symbols.prompt) + 1;
    const budget = Math.max(width - prefixWidth, 4);
    const visible = this.#visibleInput();
    const cursorRow = this.#editor.getCursorRow();
    const cursorWidth = textWidth(this.#editor.getRowClusters(cursorRow).slice(0, this.#editor.getCursorCol()).join(""));
    const scroll = Math.max(0, cursorWidth - budget + 1);
    return visible.rows.map((text, row) => {
      const lead = row === 0 ? prefix : " ".repeat(prefixWidth);
      // Only the caret row scrolls horizontally; other rows show their tail.
      const body = row === visible.cursorRow
        ? sliceByCells(text, scroll, budget)
        : sliceByCells(text, Math.max(0, textWidth(text) - budget), budget);
      return lead + body;
    });
  }

  // Terminal column of the caret on its visible input row.
  #cursorColumnInRow(width: number): number {
    const prefixWidth = textWidth(this.#theme.symbols.prompt) + 1;
    const before = this.#editor.getRowClusters(this.#editor.getCursorRow()).slice(0, this.#editor.getCursorCol()).join("");
    const cursorWidth = textWidth(before);
    const budget = Math.max(width - prefixWidth, 1);
    const scroll = Math.max(0, cursorWidth - budget + 1);
    return Math.min(Math.max(prefixWidth + cursorWidth - scroll + 1, 1), width);
  }

  #completionLines(width: number): string[] {
    if (this.#mode !== "input" || !this.#completionActive()) return [];
    const items = this.#completionMatches();
    const selectedIndex = Math.min(this.#completion.selectedIndex, Math.max(items.length - 1, 0));
    if (items.length === 0) return [this.#theme.style.dim(`  no matching commands`)];
    const lines = items.map((item, index) => {
      const marker = index === selectedIndex ? this.#theme.symbols.prompt : " ";
      const label = `${marker} ${item.name}`;
      const description = item.description.length > 0
        ? `  ${this.#theme.style.dim(sliceByCells(item.description, 0, Math.max(width - textWidth(label) - 4, 0)))}`
        : "";
      const line = `${label}${description}`;
      return index === selectedIndex ? this.#theme.brandText(line) : line;
    });
    lines.push(this.#theme.style.dim("  ↑↓ select · tab complete · enter run · esc dismiss"));
    return lines;
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
    this.#lastCursorCell = undefined;
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
