// Bottom inline managed region. Rendered lines live in the bottom lines of
// the terminal; `print` moves lines permanently into scrollback above the
// region. Invariant: after render/print the cursor sits at column 1 exactly
// one line below the region, so the next paint can lift back over it.

import { cursorToColumn, cursorUp, eraseLineAll, eraseScreenBelow } from "./ansi";
import { wrapText } from "./width";

export interface ScreenSink {
  write(data: string): void;
}

export interface InlineScreenOptions {
  sink: ScreenSink;
  columns: () => number;
}

export class InlineScreen {
  readonly #sink: ScreenSink;
  readonly #columns: () => number;
  #painted: string[] = [];

  constructor(options: InlineScreenOptions) {
    this.#sink = options.sink;
    this.#columns = options.columns;
  }

  get paintedLines(): number {
    return this.#painted.length;
  }

  // Replaces the managed region. Unstyled overlong lines are hard-wrapped as
  // a safety net; styled lines are trusted to already fit because wrapping
  // cannot split an ANSI sequence safely.
  render(lines: readonly string[]): void {
    const physical = lines.flatMap((line) => this.#physicalLines(line));
    this.#write(this.#lift());
    this.#write(this.#block(physical));
    this.#write(eraseScreenBelow());
    this.#painted = physical;
  }

  // Writes lines into scrollback above the managed region and repaints it.
  print(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const sealed = lines.flatMap((line) => this.#physicalLines(line));
    this.#write(this.#lift());
    this.#write(this.#block(sealed));
    if (this.#painted.length > 0) this.#write(this.#block(this.#painted));
    this.#write(eraseScreenBelow());
  }

  // Erases the managed region and leaves the cursor where its top was.
  dispose(): void {
    this.#write(this.#lift());
    this.#write(eraseScreenBelow());
    this.#painted = [];
  }

  #physicalLines(line: string): string[] {
    if (line.includes("\x1b")) return [line];
    if (line === "") return [""];
    return wrapText(line, this.#columns());
  }

  #lift(): string {
    return this.#painted.length > 0 ? cursorUp(this.#painted.length) + cursorToColumn(1) : "";
  }

  #block(lines: readonly string[]): string {
    let output = "";
    for (const line of lines) output += `${eraseLineAll()}${line}\n`;
    return output;
  }

  #write(data: string): void {
    if (data.length > 0) this.#sink.write(data);
  }
}
