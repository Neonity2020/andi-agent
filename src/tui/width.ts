// Width-aware text helpers. Terminal cells (not code points) are the unit:
// CJK characters occupy two cells and combining marks occupy none, so all
// cursor math and wrapping must go through these functions.

const segmenter: Intl.Segmenter | undefined =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

export function graphemes(text: string): string[] {
  if (segmenter) {
    return Array.from(segmenter.segment(text) as Iterable<{ segment: string }>, (part) => part.segment);
  }
  return Array.from(text);
}

export function textWidth(text: string): number {
  return Bun.stringWidth(text);
}

export function padEndWidth(text: string, width: number, fill = " "): string {
  const fillWidth = textWidth(fill);
  if (fillWidth === 0) return text;
  const remaining = width - textWidth(text);
  if (remaining <= 0) return text;
  return text + fill.repeat(Math.floor(remaining / fillWidth));
}

// Slices text to the widest prefix that fits `width` cells, appending the
// ellipsis inside the budget. Grapheme-safe: never splits a cluster.
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (textWidth(text) <= width) return text;
  const ellipsisWidth = textWidth(ellipsis);
  if (ellipsisWidth > width) return "";
  const budget = width - ellipsisWidth;
  let used = 0;
  const kept: string[] = [];
  for (const cluster of graphemes(text)) {
    const clusterWidth = textWidth(cluster);
    if (used + clusterWidth > budget) break;
    kept.push(cluster);
    used += clusterWidth;
  }
  return kept.join("") + ellipsis;
}

// Hard-splits a single unbreakable token so no output line ever exceeds
// `width` cells (URLs, long paths).
function splitOversized(token: string, width: number): string[] {
  const parts: string[] = [];
  let current = "";
  let used = 0;
  for (const cluster of graphemes(token)) {
    const clusterWidth = textWidth(cluster);
    if (used + clusterWidth > width && current.length > 0) {
      parts.push(current);
      current = cluster;
      used = clusterWidth;
    } else {
      current += cluster;
      used += clusterWidth;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

// Wide clusters (CJK, full-width punctuation, emoji) may break anywhere;
// narrow clusters only break on spaces.
const isWideCluster = (cluster: string): boolean => textWidth(cluster) >= 2;

function wrapLogicalLine(line: string, width: number): string[] {
  // Wide clusters stand alone as tokens (they may break anywhere); runs of
  // narrow clusters form words that only break at spaces.
  const tokens: string[] = [];
  let word = "";
  for (const cluster of graphemes(line)) {
    if (cluster === " ") {
      if (word.length > 0) {
        tokens.push(word);
        word = "";
      }
      tokens.push(" ");
    } else if (isWideCluster(cluster)) {
      if (word.length > 0) {
        tokens.push(word);
        word = "";
      }
      tokens.push(cluster);
    } else {
      word += cluster;
    }
  }
  if (word.length > 0) tokens.push(word);

  const wrapped: string[] = [];
  let current = "";
  let used = 0;
  let pendingSpace = false;
  for (const token of tokens) {
    if (token === " ") {
      pendingSpace = true;
      continue;
    }
    for (const part of textWidth(token) > width ? splitOversized(token, width) : [token]) {
      const partWidth = textWidth(part);
      const spaceWidth = pendingSpace && current.length > 0 ? 1 : 0;
      if (current.length > 0 && used + spaceWidth + partWidth > width) {
        wrapped.push(current);
        current = "";
        used = 0;
      }
      if (pendingSpace && current.length > 0) {
        current += " ";
        used += 1;
      }
      pendingSpace = false;
      current += part;
      used += partWidth;
    }
  }
  if (current.length > 0 || wrapped.length === 0) wrapped.push(current);
  return wrapped;
}

// Word-wraps text to `width` cells. Existing newlines are preserved; CJK
// characters break anywhere; unbreakable tokens longer than `width` are
// hard-split. Never returns an empty array for non-empty input.
export function wrapText(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 1) throw new Error("width must be a positive integer");
  const lines: string[] = [];
  for (const logical of text.split("\n")) lines.push(...wrapLogicalLine(logical, width));
  return lines.length > 0 ? lines : [""];
}
