import type { MemoryDocument, MemoryMatch } from "./types";

export interface RankMemoryOptions {
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

export function tokenizeMemoryText(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const tokens: string[] = [];
  const segmenter = createWordSegmenter();
  if (segmenter) {
    for (const part of segmenter.segment(normalized)) {
      if (!part.isWordLike) continue;
      addToken(tokens, part.segment);
    }
  } else {
    for (const token of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) addToken(tokens, token);
  }

  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = [...run];
    if (characters.length === 1) addToken(tokens, characters[0] as string);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      addToken(tokens, `${characters[index]}${characters[index + 1]}`);
    }
  }
  return [...new Set(tokens)];
}

export function rankMemoryDocuments(
  documents: readonly MemoryDocument[],
  query: string,
  options: RankMemoryOptions = {},
): MemoryMatch[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Memory search limit must be 1-20");
  const queryText = query.trim().normalize("NFKC").toLocaleLowerCase();
  const queryTokens = tokenizeMemoryText(queryText);
  if (queryText.length === 0 || queryTokens.length === 0) return [];

  return documents
    .flatMap((document): MemoryMatch[] => {
      const title = document.title.normalize("NFKC").toLocaleLowerCase();
      const tags = document.tags.map((tag) => tag.normalize("NFKC").toLocaleLowerCase());
      const body = document.content.normalize("NFKC").toLocaleLowerCase();
      const titleTokens = new Set(tokenizeMemoryText(title));
      const tagTokens = new Set(tokenizeMemoryText(tags.join(" ")));
      const bodyTokens = new Set(tokenizeMemoryText(body));
      let score = 0;
      let matchedTokens = 0;
      for (const token of queryTokens) {
        let matched = false;
        if (titleTokens.has(token)) {
          score += 6;
          matched = true;
        }
        if (tagTokens.has(token)) {
          score += 4;
          matched = true;
        }
        if (bodyTokens.has(token)) {
          score += 1;
          matched = true;
        }
        if (matched) matchedTokens += 1;
      }
      if (queryText.length >= 3 && title.includes(queryText)) score += 10;
      if (queryText.length >= 3 && body.includes(queryText)) score += 4;
      if (matchedTokens === 0 || score < 2) return [];
      score += (matchedTokens / queryTokens.length) * 3;
      return [
        {
          id: document.id,
          title: document.title,
          tags: [...document.tags],
          updated: document.updated,
          path: document.path,
          score: Math.round(score * 100) / 100,
          snippet: createSnippet(document.content, queryTokens),
        },
      ];
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function createWordSegmenter(): Intl.Segmenter | undefined {
  try {
    return new Intl.Segmenter(undefined, { granularity: "word" });
  } catch {
    return undefined;
  }
}

function addToken(tokens: string[], value: string): void {
  const token = value.trim();
  if (token.length === 0 || STOP_WORDS.has(token)) return;
  tokens.push(token);
}

function createSnippet(content: string, queryTokens: readonly string[]): string {
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  let offset = -1;
  for (const token of queryTokens) {
    const candidate = normalized.indexOf(token);
    if (candidate !== -1 && (offset === -1 || candidate < offset)) offset = candidate;
  }
  const start = Math.max(0, offset === -1 ? 0 : offset - 80);
  const raw = content.slice(start, start + 320).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${raw}${start + 320 < content.length ? "…" : ""}`;
}
