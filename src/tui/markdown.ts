// Standard markdown renderer for assistant output using marked Lexer AST.
// Untrusted model text is rendered as text only; no HTML passthrough.

import { Lexer, type Tokens } from "marked";
import type { Theme } from "./theme";
import { textWidth, wrapText } from "./width";

export function renderMarkdown(text: string, width: number, theme: Theme): string[] {
  if (!Number.isInteger(width) || width < 4) throw new Error("width must be at least 4");

  const output: string[] = [];

  const ensureBlockGap = (): void => {
    if (output.length > 0 && output[output.length - 1] !== "") {
      output.push("");
    }
  };

  const tokens = Lexer.lex(text);

  for (const token of tokens) {
    switch (token.type) {
      case "space": {
        ensureBlockGap();
        break;
      }
      case "heading": {
        ensureBlockGap();
        for (const part of wrapText(token.text, width)) {
          output.push(applyInline(theme.style.bold(part), theme));
        }
        break;
      }
      case "paragraph": {
        ensureBlockGap();
        for (const part of wrapText(token.text, width)) {
          output.push(applyInline(part, theme));
        }
        break;
      }
      case "code": {
        ensureBlockGap();
        const codeLines = token.text.split("\n");
        for (const codeLine of codeLines) {
          for (const part of wrapText(codeLine, Math.max(width - 2, 2))) {
            output.push(theme.style.dim(`${theme.symbols.bar} ${part}`));
          }
        }
        break;
      }
      case "list": {
        ensureBlockGap();
        const ordered = token.ordered;
        token.items.forEach((item: Tokens.ListItem, index: number) => {
          const marker = ordered ? `${index + 1}. ` : `${theme.symbols.bullet} `;
          const styledMarker = ordered ? marker : `${theme.brandText(theme.symbols.bullet)} `;
          for (const part of prefixLines(marker, styledMarker, item.text, width)) {
            output.push(applyInline(part, theme));
          }
        });
        break;
      }
      case "table": {
        ensureBlockGap();
        const headers = token.header.map((h: Tokens.TableCell) => h.text);
        const rows = token.rows.map((row: Tokens.TableCell[]) => row.map((cell: Tokens.TableCell) => cell.text));
        const alignments = token.align.map(
          (a: "center" | "left" | "right" | null) => (a === "center" || a === "right" ? a : "left") as TableAlignment,
        );
        for (const tableLine of renderTable(headers, rows, alignments, width, theme)) {
          output.push(tableLine);
        }
        break;
      }
      case "blockquote": {
        ensureBlockGap();
        for (const part of wrapText(token.text, Math.max(width - 2, 2))) {
          output.push(theme.style.dim(`│ ${applyInline(part, theme)}`));
        }
        break;
      }
      case "hr": {
        ensureBlockGap();
        output.push(theme.style.dim("─".repeat(Math.min(width, 40))));
        break;
      }
      default: {
        if ("text" in token && typeof (token as { text: unknown }).text === "string") {
          ensureBlockGap();
          for (const part of wrapText((token as { text: string }).text, width)) {
            output.push(applyInline(part, theme));
          }
        }
        break;
      }
    }
  }

  // Trim empty lines from head and tail
  while (output.length > 0 && output[0] === "") output.shift();
  while (output.length > 0 && output.at(-1) === "") output.pop();

  return output;
}

type TableAlignment = "left" | "center" | "right";

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
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_all, bold: string) => theme.style.bold(bold))
    .replace(/`([^`]+)`/g, (_all, code: string) => theme.infoText(code));
}

function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  alignments: readonly TableAlignment[],
  width: number,
  theme: Theme,
): string[] {
  const allRows = [headers, ...rows];
  const colCount = headers.length;
  const naturalWidths = headers.map((_header, column) =>
    Math.max(1, ...allRows.map((row) => textWidth(row[column] ?? ""))),
  );
  // Grid borders overhead: 1 left + 1 right + (colCount - 1) dividers + 2*colCount inner spaces
  const overhead = 1 + 1 + (colCount - 1) + 2 * colCount;
  const available = Math.max(colCount, width - overhead);
  const widths = fitTableWidths(naturalWidths, available);

  const border = (left: string, mid: string, right: string): string =>
    theme.style.dim(left + widths.map((colWidth) => "─".repeat(colWidth + 2)).join(mid) + right);

  const output: string[] = [];
  output.push(border("┌", "┬", "┐"));
  output.push(...renderTableRow(headers, widths, alignments, theme, true));
  output.push(border("├", "┼", "┤"));
  for (const row of rows) {
    output.push(...renderTableRow(row, widths, alignments, theme, false));
  }
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
  const sep = theme.style.dim("│");
  return Array.from({ length: height }, (_value, lineIndex) => {
    const cells = widths.map((columnWidth, column) => {
      const value = wrapped[column]?.[lineIndex] ?? "";
      return formatTableCell(value, columnWidth, alignments[column] ?? "left", theme, header);
    });
    return `${sep} ${cells.join(` ${sep} `)} ${sep}`;
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
  // Measure rendered width, not raw width: applyInline strips markdown markers
  // (e.g. **bold**) and may add ANSI escape codes, both of which change the
  // visible cell width. Using textWidth(value) under-pads the cell whenever a
  // row contains inline markers, leaving rows narrower than the borders.
  const visible = styled.replace(/\x1b\[[0-9;]*m/g, "");
  const missing = Math.max(0, width - textWidth(visible));
  if (alignment === "right") return " ".repeat(missing) + styled;
  if (alignment === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + styled + " ".repeat(missing - left);
  }
  return styled + " ".repeat(missing);
}
