// ANSI escape-sequence builders. Styling helpers degrade to plain text when
// disabled so rendering code runs unchanged in tests and NO_COLOR pipelines.

export interface TextStyle {
  dim(text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  fg(color: number, text: string): string;
}

const RESET = "\x1b[0m";

function identity(text: string): string {
  return text;
}

export function createTextStyle(enabled: boolean): TextStyle {
  if (!enabled) {
    return { dim: identity, bold: identity, italic: identity, fg: (_color, text) => text };
  }
  const styled = (text: string, sequence: string): string => (text.length === 0 ? text : `${sequence}${text}${RESET}`);
  return {
    dim: (text) => styled(text, "\x1b[2m"),
    bold: (text) => styled(text, "\x1b[1m"),
    italic: (text) => styled(text, "\x1b[3m"),
    fg: (color, text) => styled(text, `\x1b[38;5;${color}m`),
  };
}

export function cursorUp(lines: number): string {
  return lines > 0 ? `\x1b[${lines}A` : "";
}

export function cursorToColumn(column: number): string {
  return column > 1 ? `\x1b[${column}G` : "\r";
}

export function eraseLineAll(): string {
  return "\x1b[2K";
}

export function eraseScreenBelow(): string {
  return "\x1b[J";
}

export function hideCursor(): string {
  return "\x1b[?25l";
}

export function showCursor(): string {
  return "\x1b[?25h";
}

export function enableBracketedPaste(): string {
  return "\x1b[?2004h";
}

export function disableBracketedPaste(): string {
  return "\x1b[?2004l";
}
