// Palette, symbols, and semantic styling helpers for the TUI. All color use
// goes through TextStyle so NO_COLOR and non-TTY output degrade cleanly.

import { createTextStyle, type TextStyle } from "./ansi";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface Theme {
  readonly style: TextStyle;
  readonly colors: Readonly<{
    brand: number;
    tool: number;
    success: number;
    error: number;
    warn: number;
    info: number;
    muted: number;
  }>;
  readonly symbols: Readonly<{
    prompt: string;
    check: string;
    cross: string;
    bullet: string;
    dot: string;
    bar: string;
    arrow: string;
    ellipsis: string;
    spinner: readonly string[];
  }>;
  brandText(text: string): string;
  toolText(text: string): string;
  successText(text: string): string;
  errorText(text: string): string;
  warnText(text: string): string;
  infoText(text: string): string;
}

const COLORS = {
  brand: 39,
  tool: 179,
  success: 114,
  error: 203,
  warn: 214,
  info: 80,
  muted: 245,
};

const SYMBOLS = {
  prompt: "❯",
  check: "✓",
  cross: "✗",
  bullet: "•",
  dot: "·",
  bar: "│",
  arrow: "→",
  ellipsis: "…",
  spinner: SPINNER_FRAMES,
};

export function createTheme(colorEnabled: boolean): Theme {
  const style = createTextStyle(colorEnabled);
  return {
    style,
    colors: COLORS,
    symbols: SYMBOLS,
    brandText: (text) => style.fg(COLORS.brand, text),
    toolText: (text) => style.fg(COLORS.tool, text),
    successText: (text) => style.fg(COLORS.success, text),
    errorText: (text) => style.fg(COLORS.error, text),
    warnText: (text) => style.fg(COLORS.warn, text),
    infoText: (text) => style.fg(COLORS.info, text),
  };
}
