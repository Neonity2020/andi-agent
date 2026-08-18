// Lightweight markdown renderer for assistant output: fenced code blocks,
// headings, bullets, bold, and inline code, wrapped to the terminal width.
// Untrusted model text is rendered as text only; no HTML passthrough.

import type { Theme } from "./theme";
import { textWidth, wrapText } from "./width";

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

  for (const rawLine of text.split("\n")) {
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
