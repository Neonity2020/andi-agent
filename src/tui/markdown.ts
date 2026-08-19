// Lightweight markdown renderer for assistant output: fenced code blocks,
// headings, bullets, bold, and inline code, wrapped to the terminal width.
// Untrusted model text is rendered as text only; no HTML passthrough.

import type { Theme } from "./theme";
import { padEndWidth, textWidth, wrapText } from "./width";

export function renderMarkdown(text: string, width: number, theme: Theme): string[] {
  if (!Number.isInteger(width) || width < 4) throw new Error("width must be at least 4");

  const output: string[] = [];
  let inFence = false;
  let pendingBlank = false;

  const emit = (line: string): void => {
    if (line.length === 0) {
      if (output.length > 0) pendingBlank = true;
      return;
    }
    if (pendingBlank) {
      output.push("");
      pendingBlank = false;
    }
    output.push(line);
  };

  const rawLines = text.split("\n");
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const rawLine = rawLines[lineIndex] ?? "";
    const line = rawLine.replace(/\s+$/, "");

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (!inFence) pendingBlank = true;
      else if (output.length > 0) pendingBlank = true;
      continue;
    }

    if (inFence) {
      for (const part of wrapText(line, Math.max(width - 2, 2))) {
        emit(theme.style.dim(`${theme.symbols.bar} ${part}`));
      }
      continue;
    }

    if (line.trim().length === 0) {
      emit("");
      continue;
    }

    const table = parseTable(rawLines, lineIndex);
    if (table) {
      for (const tableLine of renderTable(table, width, theme)) emit(tableLine);
      lineIndex = table.endLine;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading?.[2] !== undefined) {
      for (const part of wrapText(heading[2], width)) emit(applyInline(theme.style.bold(part), theme));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet?.[2] !== undefined) {
      const prefix = `${theme.brandText(theme.symbols.bullet)} `;
      for (const part of prefixLines(`${theme.symbols.bullet} `, prefix, bullet[2], width)) {
        emit(applyInline(part, theme));
      }
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ordered?.[3] !== undefined) {
      const marker = `${ordered[2]}. `;
      for (const part of prefixLines(marker, marker, ordered[3], width)) {
        emit(applyInline(part, theme));
      }
      continue;
    }

    for (const part of wrapText(line, width)) emit(applyInline(part, theme));
  }
  return output;
}

// Wraps text under a prefix: the first output line carries the styled prefix,
// continuation lines align under it.
function prefixLines(
  plainPrefix: string,
  styledPrefix: string,
  text: string,
  width: number,
): string[] {
  const budget = Math.max(width - textWidth(plainPrefix), 4);
  const indent = " ".repeat(textWidth(plainPrefix));
  return wrapText(text, budget).map((line, index) => (index === 0 ? styledPrefix + line : indent + line));
}

function applyInline(line: string, theme: Theme): string {
  return line.replace(/\*\*([^*]+)\*\*/g, (_all, bold: string) => theme.style.bold(bold)).replace(
    /`([^`]+)`/g,
    (_all, code: string) => theme.infoText(code),
  );
}

interface MarkdownTable {
  headers: string[];
  rows: string[][];
  alignments: TableAlignment[];
  endLine: number;
}

type TableAlignment = "left" | "center" | "right";

function parseTable(lines: readonly string[], startLine: number): MarkdownTable | undefined {
  const header = parseTableRow(lines[startLine] ?? "");
  const delimiter = parseTableRow(lines[startLine + 1] ?? "");
  if (!header || !delimiter || delimiter.length !== header.length || !delimiter.every(isDelimiterCell)) return undefined;

  const rows: string[][] = [];
  let endLine = startLine + 1;
  for (let index = startLine + 2; index < lines.length; index += 1) {
    const row = parseTableRow(lines[index] ?? "");
    if (!row) break;
    rows.push([...row.slice(0, header.length), ...Array(Math.max(0, header.length - row.length)).fill("")]);
    endLine = index;
  }

  return {
    headers: header,
    rows,
    alignments: delimiter.map(tableAlignment),
    endLine,
  };
}

function parseTableRow(line: string): string[] | undefined {
  if (!line.includes("|")) return undefined;
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.length >= 2 ? cells : undefined;
}

function isDelimiterCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell);
}

function tableAlignment(cell: string): TableAlignment {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function renderTable(table: MarkdownTable, width: number, theme: Theme): string[] {
  const sourceRows = [table.headers, ...table.rows];
  const naturalWidths = table.headers.map((_header, column) =>
    Math.max(1, ...sourceRows.map((row) => textWidth(row[column] ?? ""))),
  );
  const available = Math.max(table.headers.length, width - table.headers.length * 3 - 1);
  const widths = fitTableWidths(naturalWidths, available);
  const border = (left: string, middle: string, right: string): string =>
    left + widths.map((columnWidth) => "─".repeat(columnWidth + 2)).join(middle) + right;
  const output = [border("┌", "┬", "┐")];
  output.push(...renderTableRow(table.headers, widths, table.alignments, theme, true));
  output.push(border("├", "┼", "┤"));
  for (const row of table.rows) output.push(...renderTableRow(row, widths, table.alignments, theme, false));
  output.push(border("└", "┴", "┘"));
  return output;
}

function fitTableWidths(naturalWidths: readonly number[], available: number): number[] {
  const widths = naturalWidths.map((value) => Math.max(1, value));
  if (widths.reduce((total, value) => total + value, 0) <= available) return widths;
  const result = widths.map(() => 1);
  let remaining = Math.max(0, available - result.length);
  while (remaining > 0) {
    let changed = false;
    for (let index = 0; index < result.length && remaining > 0; index += 1) {
      if (result[index]! < widths[index]!) {
        result[index] = result[index]! + 1;
        remaining -= 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

function renderTableRow(
  row: readonly string[],
  widths: readonly number[],
  alignments: readonly TableAlignment[],
  theme: Theme,
  header: boolean,
): string[] {
  const wrapped = row.map((cell, index) => wrapText(cell, widths[index] ?? 1));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));
  return Array.from({ length: height }, (_value, lineIndex) => {
    const cells = widths.map((columnWidth, column) => {
      const value = wrapped[column]?.[lineIndex] ?? "";
      return formatTableCell(value, columnWidth, alignments[column] ?? "left", theme, header);
    });
    return `│ ${cells.join(" │ ")} │`;
  });
}

function formatTableCell(
  value: string,
  width: number,
  alignment: TableAlignment,
  theme: Theme,
  header: boolean,
): string {
  const styled = applyInline(header ? theme.style.bold(value) : value, theme);
  const missing = Math.max(0, width - textWidth(value));
  if (alignment === "right") return " ".repeat(missing) + styled;
  if (alignment === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + styled + " ".repeat(missing - left);
  }
  return padEndWidth(styled, width);
}
