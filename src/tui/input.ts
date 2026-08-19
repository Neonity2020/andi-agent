// Raw-mode input decoding and multi-line text editing. InputDecoder turns
// stdin bytes into KeyEvent values (escape sequences may arrive split across
// chunks); LineEditor is a pure state machine over grapheme-cluster rows so
// the renderer can compute cursor cells with width.ts.

import { graphemes } from "./width";

export type KeyName =
  | "text"
  | "paste"
  | "enter"
  | "newline"
  | "tab"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "wordLeft"
  | "wordRight"
  | "escape"
  | "interrupt"
  | "eof"
  | "killLine"
  | "killToStart"
  | "killWord"
  | "unknown";

export interface KeyEvent {
  key: KeyName;
  text?: string;
  bytes?: number[];
}

const CTRL_KEYS: Record<number, KeyName> = {
  0x01: "home",
  0x02: "left",
  0x03: "interrupt",
  0x04: "eof",
  0x05: "end",
  0x06: "right",
  0x08: "backspace",
  0x0b: "killLine",
  0x0e: "down",
  0x10: "up",
  0x15: "killToStart",
  0x17: "killWord",
};

const CSI_FINALS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_TILDES: Record<string, KeyName> = {
  1: "home",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
};

const isFinalByte = (byte: number): boolean => byte >= 0x40 && byte <= 0x7e;

function utf8Length(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc2) return 2;
  return 1;
}

const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];

const decoder = new TextDecoder();

export class InputDecoder {
  #buffer: number[] = [];
  #pasting = false;

  push(data: Uint8Array): KeyEvent[] {
    this.#buffer.push(...data);
    const events: KeyEvent[] = [];
    for (let event = this.#decodeNext(); event; event = this.#decodeNext()) events.push(event);
    return events;
  }

  flushEscape(): KeyEvent | undefined {
    if (this.#buffer.length === 1 && this.#buffer[0] === 0x1b) {
      return this.#consume(1, { key: "escape" });
    }
    return undefined;
  }

  #decodeNext(): KeyEvent | undefined {
    if (this.#buffer.length === 0) return undefined;

    if (this.#pasting) {
      const end = this.#findSequence(PASTE_END);
      if (end < 0) return undefined;
      const text = decoder.decode(Uint8Array.from(this.#buffer.slice(0, end)));
      this.#buffer = this.#buffer.slice(end + PASTE_END.length);
      this.#pasting = false;
      return { key: "paste", text };
    }

    const head = this.#buffer.at(0);
    if (head === undefined) return undefined;
    if (head === 0x1b) return this.#decodeEscape();
    // CR submits; LF maps to Ctrl+J so multi-line editors can use it as the
    // soft newline key (the OpenCode input_newline default).
    if (head === 0x0d) return this.#consume(1, { key: "enter" });
    if (head === 0x0a) return this.#consume(1, { key: "newline" });
    if (head === 0x09) return this.#consume(1, { key: "tab" });
    if (head === 0x7f) return this.#consume(1, { key: "backspace" });
    if (head < 0x20) {
      const mapped = CTRL_KEYS[head];
      return this.#consume(1, mapped ? { key: mapped } : { key: "unknown", bytes: [head] });
    }

    // Maximal run of printable text; a truncated UTF-8 sequence at the end
    // stays buffered until the next chunk completes it.
    let end = 0;
    while (end < this.#buffer.length) {
      const byte = this.#buffer[end];
      if (byte === undefined || byte < 0x20 || byte === 0x7f) break;
      const length = utf8Length(byte);
      if (end + length > this.#buffer.length) break;
      end += length;
    }
    if (end === 0) return undefined;
    const text = decoder.decode(Uint8Array.from(this.#buffer.slice(0, end)));
    return this.#consume(end, { key: "text", text });
  }

  #consume(count: number, event: KeyEvent): KeyEvent {
    this.#buffer = this.#buffer.slice(count);
    return event;
  }

  #decodeEscape(): KeyEvent | undefined {
    const second = this.#buffer.at(1);
    if (second === undefined) return undefined;
    if (second === 0x5b) return this.#decodeCsi();
    if (second === 0x4f) {
      const third = this.#buffer.at(2);
      if (third === undefined) return undefined;
      const mapped = CSI_FINALS[String.fromCharCode(third)];
      const bytes = this.#buffer.slice(0, 3);
      return this.#consume(3, mapped ? { key: mapped } : { key: "unknown", bytes });
    }
    if (second === 0x5d) return this.#skipOsc();
    if (second === 0x1b) return this.#consume(1, { key: "escape" });
    if (second === 0x62) return this.#consume(2, { key: "wordLeft" });
    if (second === 0x66) return this.#consume(2, { key: "wordRight" });
    if (second === 0x7f) return this.#consume(2, { key: "killWord" });
    const bytes = this.#buffer.slice(0, 2);
    return this.#consume(2, { key: "unknown", bytes });
  }

  #decodeCsi(): KeyEvent | undefined {
    let end = -1;
    for (let index = 2; index < this.#buffer.length; index += 1) {
      const byte = this.#buffer[index];
      if (byte !== undefined && isFinalByte(byte)) {
        end = index;
        break;
      }
    }
    if (end < 0) return undefined;
    const final = this.#buffer[end];
    if (final === undefined) return undefined;
    const params = String.fromCharCode(...this.#buffer.slice(2, end));
    const finalByte = String.fromCharCode(final);
    const count = end + 1;
    const bytes = this.#buffer.slice(0, count);

    if (finalByte === "~") {
      if (params === "200") {
        this.#buffer = this.#buffer.slice(count);
        this.#pasting = true;
        return this.#decodeNext();
      }
      if (params === "201") return this.#consume(count, { key: "unknown", bytes });
      const mapped = CSI_TILDES[params.split(";")[0] ?? ""];
      return this.#consume(count, mapped ? { key: mapped } : { key: "unknown", bytes });
    }

    const direct = CSI_FINALS[finalByte];
    if (direct) {
      // Ctrl/Alt-modified arrows (e.g. "1;5C") map to word motions.
      if (params.includes(";")) {
        if (finalByte === "C") return this.#consume(count, { key: "wordRight" });
        if (finalByte === "D") return this.#consume(count, { key: "wordLeft" });
      }
      return this.#consume(count, { key: direct });
    }
    return this.#consume(count, { key: "unknown", bytes });
  }

  #skipOsc(): KeyEvent | undefined {
    for (let index = 2; index < this.#buffer.length; index += 1) {
      if (this.#buffer[index] === 0x07) {
        this.#buffer = this.#buffer.slice(index + 1);
        return this.#decodeNext();
      }
      if (this.#buffer[index] === 0x1b && this.#buffer[index + 1] === 0x5c) {
        this.#buffer = this.#buffer.slice(index + 2);
        return this.#decodeNext();
      }
    }
    return undefined;
  }

  #findSequence(sequence: number[]): number {
    outer: for (let index = 0; index + sequence.length <= this.#buffer.length; index += 1) {
      for (let offset = 0; offset < sequence.length; offset += 1) {
        if (this.#buffer[index + offset] !== sequence[offset]) continue outer;
      }
      return index;
    }
    return -1;
  }
}

export type EditorAction =
  | { type: "none" }
  | { type: "changed" }
  | { type: "submitted"; line: string }
  | { type: "interrupt" }
  | { type: "eof" }
  | { type: "escape" };

const CHANGED: EditorAction = { type: "changed" };
const NONE: EditorAction = { type: "none" };

export class LineEditor {
  #lines: string[][] = [[]];
  #row = 0;
  #col = 0;
  #history: string[];
  #historyIndex: number;
  #draft = "";

  constructor(history: readonly string[] = []) {
    this.#history = [...history];
    this.#historyIndex = this.#history.length;
  }

  getText(): string {
    return this.#lines.map((line) => line.join("")).join("\n");
  }

  getCursorRow(): number {
    return this.#row;
  }

  getCursorCol(): number {
    return this.#col;
  }

  getLineCount(): number {
    return this.#lines.length;
  }

  getRowClusters(row: number): readonly string[] {
    return this.#lines[row] ?? [];
  }

  addHistory(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0 || this.#history[this.#history.length - 1] === trimmed) return;
    this.#history.push(trimmed);
    this.#historyIndex = this.#history.length;
    this.#draft = "";
  }

  reset(): void {
    this.#lines = [[]];
    this.#row = 0;
    this.#col = 0;
    this.#historyIndex = this.#history.length;
    this.#draft = "";
  }

  // Replaces the whole buffer (autocomplete insertion) and puts the cursor at
  // the end of the first line.
  setText(text: string): EditorAction {
    const [first = "", ...rest] = text.split("\n");
    this.#lines = [graphemes(first), ...rest.map((line) => graphemes(line))];
    this.#row = 0;
    this.#col = this.#lines[0]?.length ?? 0;
    return this.#col > 0 || this.#lines.length > 1 ? CHANGED : NONE;
  }

  insertText(text: string): EditorAction {
    if (text.length === 0) return NONE;
    const parts = text.replace(/\r/g, "").split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) this.#splitLine();
      const clusters = graphemes(parts[index] ?? "");
      this.#currentLine().splice(this.#col, 0, ...clusters);
      this.#col += clusters.length;
    }
    return CHANGED;
  }

  handleKey(event: KeyEvent): EditorAction {
    switch (event.key) {
    case "text":
      return this.insertText(event.text ?? "");
    case "paste":
      // Multi-line pastes keep their newlines so code snippets arrive intact.
      return this.insertText(event.text ?? "");
    case "enter":
      return this.submit();
    case "newline":
      this.#splitLine();
      return CHANGED;
    case "backspace": {
      if (this.#col === 0) {
        if (this.#row === 0) return NONE;
        const current = this.#lines[this.#row] ?? [];
        this.#row -= 1;
        this.#col = this.#currentLine().length;
        this.#currentLine().push(...current);
        this.#lines.splice(this.#row + 1, 1);
        return CHANGED;
      }
      this.#currentLine().splice(this.#col - 1, 1);
      this.#col -= 1;
      return CHANGED;
    }
    case "delete": {
      const line = this.#currentLine();
      if (this.#col >= line.length) {
        const next = this.#lines[this.#row + 1];
        if (next === undefined) return NONE;
        line.push(...next);
        this.#lines.splice(this.#row + 1, 1);
        return CHANGED;
      }
      line.splice(this.#col, 1);
      return CHANGED;
    }
    case "left":
      if (this.#col > 0) return this.#moveCursor(this.#row, this.#col - 1);
      if (this.#row === 0) return NONE;
      return this.#moveCursor(this.#row - 1, (this.#lines[this.#row - 1] ?? []).length);
    case "right": {
      const line = this.#currentLine();
      if (this.#col < line.length) return this.#moveCursor(this.#row, this.#col + 1);
      const next = this.#lines[this.#row + 1];
      if (next === undefined) return NONE;
      return this.#moveCursor(this.#row + 1, 0);
    }
    case "up":
      // Inside the buffer the arrows move the caret across rows; only the
      // first/last row boundary falls through to history (shell style).
      if (this.#row > 0) return this.#moveCursor(this.#row - 1, this.#col);
      return this.#loadHistory(this.#historyIndex - 1);
    case "down":
      if (this.#row < this.#lines.length - 1) {
        return this.#moveCursor(this.#row + 1, this.#col);
      }
      return this.#loadHistory(this.#historyIndex + 1);
    case "home":
      return this.#moveCursor(this.#row, 0);
    case "end":
      return this.#moveCursor(this.#row, this.#currentLine().length);
    case "wordLeft":
      return this.#moveCursor(this.#row, this.#wordLeftBoundary());
    case "wordRight":
      return this.#moveCursor(this.#row, this.#wordRightBoundary());
    case "killToStart": {
      if (this.#col === 0 && this.#row === 0) return NONE;
      if (this.#col === 0) {
        const current = this.#lines[this.#row] ?? [];
        this.#row -= 1;
        this.#col = this.#currentLine().length;
        this.#currentLine().push(...current);
        this.#lines.splice(this.#row + 1, 1);
        return CHANGED;
      }
      this.#currentLine().splice(0, this.#col);
      this.#col = 0;
      return CHANGED;
    }
    case "killLine": {
      const line = this.#currentLine();
      if (this.#col >= line.length) {
        const next = this.#lines[this.#row + 1];
        if (next === undefined) return NONE;
        line.push(...next);
        this.#lines.splice(this.#row + 1, 1);
        return CHANGED;
      }
      line.splice(this.#col);
      return CHANGED;
    }
    case "killWord": {
      const boundary = this.#wordLeftBoundary();
      if (boundary === this.#col) return NONE;
      this.#currentLine().splice(boundary, this.#col - boundary);
      this.#col = boundary;
      return CHANGED;
    }
    case "interrupt":
      return { type: "interrupt" };
    case "eof":
      return this.#lines.length === 1 && (this.#lines[0] ?? []).length === 0 ? { type: "eof" } : NONE;
    case "escape":
      return { type: "escape" };
    default:
      return NONE;
    }
  }

  submit(): EditorAction {
    const line = this.getText();
    this.addHistory(line);
    this.#lines = [[]];
    this.#row = 0;
    this.#col = 0;
    this.#draft = "";
    this.#historyIndex = this.#history.length;
    return { type: "submitted", line };
  }

  #currentLine(): string[] {
    return this.#lines[this.#row] ?? (this.#lines[this.#row] = []);
  }

  #splitLine(): void {
    const line = this.#currentLine();
    const tail = line.splice(this.#col);
    this.#lines.splice(this.#row + 1, 0, tail);
    this.#row += 1;
    this.#col = 0;
  }

  #moveCursor(row: number, col: number): EditorAction {
    const clampedRow = Math.max(0, Math.min(this.#lines.length - 1, row));
    const clampedCol = Math.max(0, Math.min((this.#lines[clampedRow] ?? []).length, col));
    if (clampedRow === this.#row && clampedCol === this.#col) return NONE;
    this.#row = clampedRow;
    this.#col = clampedCol;
    return CHANGED;
  }

  #loadHistory(index: number): EditorAction {
    if (index < 0 || index > this.#history.length) return NONE;
    if (this.#historyIndex === this.#history.length) this.#draft = this.getText();
    const entry = index === this.#history.length ? this.#draft : this.#history[index] ?? "";
    const [first = "", ...rest] = entry.split("\n");
    this.#lines = [graphemes(first), ...rest.map((line) => graphemes(line))];
    this.#historyIndex = index;
    this.#row = 0;
    this.#col = this.#lines[0]?.length ?? 0;
    return CHANGED;
  }

  #wordLeftBoundary(): number {
    let index = this.#col;
    const line = this.#currentLine();
    while (index > 0 && line[index - 1] === " ") index -= 1;
    while (index > 0 && line[index - 1] !== " ") index -= 1;
    return index;
  }

  #wordRightBoundary(): number {
    let index = this.#col;
    const line = this.#currentLine();
    while (index < line.length && line[index] !== " ") index += 1;
    while (index < line.length && line[index] === " ") index += 1;
    return index;
  }
}
