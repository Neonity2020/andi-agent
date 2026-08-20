// Live-region state: what the agent is doing right now. The Tui seals
// finished units into scrollback; this module only renders in-flight work
// (running tools, streaming preview) so the bottom region stays small.

import type { Theme } from "./theme";
import { SPINNER_FRAMES } from "./theme";
import { textWidth, truncateToWidth, wrapText } from "./width";

export interface RunningTool {
  id: string;
  name: string;
  startedAt: number;
}

export function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(elapsedMs, 0) / 90) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(ms, 0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

// Wraps text under a prefix; continuation lines align under the prefix.
function prefixLines(plainPrefix: string, styledPrefix: string, text: string, width: number): string[] {
  const budget = Math.max(width - textWidth(plainPrefix), 4);
  const indent = " ".repeat(textWidth(plainPrefix));
  return wrapText(text, budget).map((line, index) => (index === 0 ? styledPrefix + line : indent + line));
}

export function renderUserEcho(text: string, width: number, theme: Theme): string[] {
  const prefix = `${theme.brandText(theme.symbols.prompt)} `;
  return prefixLines(`${theme.symbols.prompt} `, prefix, text, width);
}

export function renderSealedTool(name: string, ok: boolean, durationMs: number, theme: Theme): string {
  const symbol = ok ? theme.successText(theme.symbols.check) : theme.errorText(theme.symbols.cross);
  const duration = theme.style.dim(` ${theme.symbols.dot} ${formatDuration(durationMs)}`);
  return `${symbol} ${theme.toolText(name)}${duration}`;
}

export function renderCancelledTool(name: string, theme: Theme): string {
  return `${theme.style.dim(theme.symbols.dot)} ${theme.toolText(name)} ${theme.style.dim("已取消")}`;
}

export interface ThinkTagResult {
  content: string;
  thinking: string;
  thinkingOpen: boolean;
}

export function parseThinkTags(input: string): ThinkTagResult {
  let content = "";
  let thinking = "";
  let cursor = 0;
  let thinkingOpen = false;
  while (cursor < input.length) {
    if (thinkingOpen) {
      const close = input.slice(cursor).search(/<\/think\s*>/i);
      if (close < 0) {
        thinking += input.slice(cursor);
        return { content, thinking, thinkingOpen: true };
      }
      thinking += input.slice(cursor, cursor + close);
      cursor += close + (input.slice(cursor + close).match(/^<\/think\s*>/i)?.[0].length ?? 0);
      thinkingOpen = false;
      continue;
    }
    const open = input.slice(cursor).search(/<think\s*>/i);
    if (open < 0) {
      content += input.slice(cursor);
      break;
    }
    content += input.slice(cursor, cursor + open);
    cursor += open + (input.slice(cursor + open).match(/^<think\s*>/i)?.[0].length ?? 0);
    thinkingOpen = true;
  }
  return { content, thinking, thinkingOpen };
}

export type ActivityPhase = "idle" | "thinking" | "streaming";

export class ActivityState {
  #phase: ActivityPhase = "idle";
  #turnStartedAt: number | undefined;
  #rawStream = "";
  #stream = "";
  #thinking = "";
  #thinkingOpen = false;
  #tools: RunningTool[] = [];

  get phase(): ActivityPhase {
    return this.#phase;
  }

  beginTurn(at: number): void {
    this.#phase = "thinking";
    this.#turnStartedAt = at;
    this.#rawStream = "";
    this.#stream = "";
    this.#thinking = "";
    this.#thinkingOpen = false;
    this.#tools = [];
  }

  endTurn(): void {
    this.#phase = "idle";
    this.#turnStartedAt = undefined;
    this.#rawStream = "";
    this.#stream = "";
    this.#thinking = "";
    this.#thinkingOpen = false;
    this.#tools = [];
  }

  appendDelta(text: string): void {
    if (this.#phase === "thinking") this.#phase = "streaming";
    this.#rawStream += text;
    const parsed = parseThinkTags(this.#rawStream);
    this.#stream = parsed.content;
    this.#thinking = parsed.thinking;
    this.#thinkingOpen = parsed.thinkingOpen;
  }

  takeStream(): string {
    const stream = this.#stream;
    this.#rawStream = "";
    this.#stream = "";
    return stream;
  }

  takeThinking(): { text: string; open: boolean } {
    return { text: this.#thinking, open: this.#thinkingOpen };
  }

  toolStarted(id: string, name: string, startedAt: number): void {
    this.#tools.push({ id, name, startedAt });
  }

  toolEnded(id: string): RunningTool | undefined {
    const index = this.#tools.findIndex((tool) => tool.id === id);
    if (index === -1) return undefined;
    return this.#tools.splice(index, 1)[0];
  }

  // Returns and clears all running tools (turn cancelled or failed).
  drainTools(): RunningTool[] {
    return this.#tools.splice(0);
  }

  // In-flight rows only: running tools (when active, they are the story),
  // otherwise a thinking or streaming indicator.
  render(now: number, width: number, theme: Theme): string[] {
    const lines: string[] = [];
    for (const tool of this.#tools) {
      const frame = theme.brandText(spinnerFrame(now - tool.startedAt));
      const elapsed = theme.style.dim(` ${theme.symbols.dot} ${formatDuration(now - tool.startedAt)}`);
      lines.push(`${frame} ${theme.toolText(tool.name)}${elapsed}`);
    }
    if (lines.length > 0) return lines;

    if (this.#thinking.length > 0 || this.#thinkingOpen) {
      const elapsed = this.#turnStartedAt === undefined
        ? ""
        : theme.style.dim(` ${theme.symbols.dot} ${formatDuration(now - this.#turnStartedAt)}`);
      const size = this.#thinking.trim().length > 0 ? ` ${theme.symbols.dot} ${this.#thinking.trim().length} 字符` : "";
      lines.push(`${theme.brandText(spinnerFrame(now - (this.#turnStartedAt ?? now)))} ${theme.style.dim(`思考（已折叠）${size}`)}${elapsed}`);
    }

    if (this.#phase === "thinking") {
      const elapsed =
        this.#turnStartedAt === undefined
          ? ""
          : theme.style.dim(` ${theme.symbols.dot} ${formatDuration(now - this.#turnStartedAt)}`);
      lines.push(`${theme.brandText(spinnerFrame(now - (this.#turnStartedAt ?? now)))} ${theme.style.dim("思考中")}${elapsed}`);
      return lines;
    }

    if (this.#phase === "streaming" && this.#stream.trim().length > 0) {
      const previewWidth = Math.max(width - 4, 8);
      const wrapped = wrapText(this.#stream.trimEnd().split("\n").at(-1) ?? "", previewWidth);
      const last = wrapped.at(-1) ?? "";
      const prefix = theme.style.dim(`${theme.symbols.ellipsis} `);
      lines.push(prefix + theme.style.dim(truncateToWidth(last, previewWidth)));
    }
    return lines;
  }
}
