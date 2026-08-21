import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "../tools/workspace";
import type {
  KnowledgeCaptureInput,
  KnowledgeCaptureResult,
  KnowledgeDocument,
  KnowledgeMatch,
  KnowledgeStatus,
} from "./types";

const KNOWLEDGE_ROOT = "kb";
const MOC_PATH = "kb/MOC.md";
const MAX_DOCUMENTS = 500;
const MAX_DOCUMENT_BYTES = 48_000;
const MAX_TOTAL_BYTES = 2_000_000;
const MAX_SOURCES = 12;
const MAX_TAGS = 16;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,63})(?:\/[a-z0-9](?:[a-z0-9_-]{0,63}))*$/;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const STATUS_VALUES = new Set<KnowledgeStatus>(["verified", "reference", "needs-review"]);
const SECRET_PATTERNS = [
  /\b(?:sk|xai|ghp|github_pat)-[A-Za-z0-9_-]{16,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /^\s*(?:AGNES|AGENT|EXA|OPENAI|ANTHROPIC|GEMINI|GROQ|MISTRAL|MOONSHOT|TOGETHER|ZHIPU|MINIMAX)_API_KEY\s*=\s*\S+/im,
];
const INDEX_START = "<!-- knowledge-index:start -->";
const INDEX_END = "<!-- knowledge-index:end -->";

export class KnowledgeStore {
  readonly #workspace: Workspace;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async list(): Promise<KnowledgeDocument[]> {
    const documents: KnowledgeDocument[] = [];
    let totalBytes = 0;
    await this.#walk(KNOWLEDGE_ROOT, async (path, bytes) => {
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Knowledge base exceeds its total size limit");
      if (documents.length >= MAX_DOCUMENTS) throw new Error(`Knowledge base is limited to ${MAX_DOCUMENTS} documents`);
        documents.push(await this.read(path.slice(KNOWLEDGE_ROOT.length + 1, -3)));
    });
    return documents.sort((left, right) => left.id.localeCompare(right.id));
  }

  async read(id: string): Promise<KnowledgeDocument> {
    validateId(id);
    const path = `${KNOWLEDGE_ROOT}/${id}.md`;
    const raw = await this.#workspace.read(path);
    if (Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) throw new Error(`Knowledge document '${id}' exceeds the size limit`);
    return parseKnowledgeDocument(id, raw);
  }

  async search(query: string, limit = 10): Promise<KnowledgeMatch[]> {
    const normalized = query.trim();
    if (normalized.length === 0) throw new Error("Knowledge search query cannot be empty");
    if (normalized.length > 2_000) throw new Error("Knowledge search query exceeds the 2000 character limit");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Knowledge search limit must be 1-20");
    const terms = tokenize(normalized);
    const documents = await this.list();
    return documents
      .map((document) => ({ document, score: score(document, terms, normalized.toLowerCase()) }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
      .slice(0, limit)
      .map(({ document, score: value }) => ({
        id: document.id,
        title: document.title,
        category: document.category,
        status: document.status,
        updated: document.updated,
        summary: document.summary,
        score: value,
        path: document.path,
      }));
  }

  async capture(input: KnowledgeCaptureInput): Promise<KnowledgeCaptureResult> {
    return this.#enqueue(async () => {
      validateCapture(input);
      const existing = await this.read(input.id).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (existing && input.expectedUpdated === undefined) {
        throw new Error(`Knowledge '${input.id}' already exists; read it and provide expected_updated before updating`);
      }
      if (existing && input.expectedUpdated !== existing.updated) {
        throw new Error(`Knowledge '${input.id}' changed since it was read; read it again before updating`);
      }
      const updated = nextUpdated(existing?.updated);
      const document = parseKnowledgeDocument(input.id, serializeKnowledge(input, updated));
      await this.#workspace.write(document.path, serializeKnowledge(input, updated));
      const mocUpdated = await this.#updateMoc(document);
      return { action: existing ? "updated" : "created", document, mocUpdated };
    });
  }

  async #walk(directory: string, visit: (path: string, bytes: number) => Promise<void>): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(this.#workspace.root, directory), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || entry.name === "README.md" || entry.name === "MOC.md") continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "_meta" || entry.name === "archive") continue;
        await this.#walk(path, visit);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const bytes = Buffer.byteLength(await this.#workspace.read(path));
        await visit(path, bytes);
      }
    }
  }

  async #updateMoc(document: KnowledgeDocument): Promise<boolean> {
    const current = await this.#workspace.read(MOC_PATH).catch((error: unknown) => {
      if (isMissing(error)) return "# Knowledge Map\n";
      throw error;
    });
    const rows = (await this.list()).map((entry) =>
      `| \`${entry.id}\` | [${entry.title}](${entry.path}) | ${entry.status} | ${entry.updated} |`,
    );
    const section = [
      "## 自动维护条目",
      "",
      "| ID | 条目 | 状态 | 更新 |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n");
    const replacement = `${INDEX_START}\n${section}\n${INDEX_END}`;
    const updated = current.includes(INDEX_START) && current.includes(INDEX_END)
      ? current.replace(new RegExp(`${escapeRegExp(INDEX_START)}[\\s\\S]*?${escapeRegExp(INDEX_END)}`), replacement)
      : `${current.trimEnd()}\n\n${replacement}\n`;
    if (updated === current) return false;
    await this.#workspace.write(MOC_PATH, updated);
    return true;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeQueue.then(operation, operation);
    this.#writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function parseKnowledgeDocument(id: string, raw: string): KnowledgeDocument {
  validateId(id);
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`Knowledge '${id}' must start with YAML front matter`);
  const metadata = parseMetadata(match[1]!);
  const content = match[2]!.trim();
  const title = metadata.title ?? id.split("/").at(-1)!.replace(/[-_]+/g, " ");
  const summary = metadata.summary ?? firstParagraph(content);
  const status = metadata.status as KnowledgeStatus | undefined;
  if (!status || !STATUS_VALUES.has(status)) throw new Error(`Knowledge '${id}' has an invalid status`);
  if (!metadata.category || !CATEGORY_PATTERN.test(metadata.category)) throw new Error(`Knowledge '${id}' has an invalid category`);
  return {
    id,
    title,
    category: metadata.category,
    type: metadata.type ?? "topic",
    status,
    updated: metadata.updated ?? "unknown",
    summary,
    tags: parseList(metadata.tags),
    sources: parseList(metadata.sources),
    related: parseList(metadata.related),
    content,
    path: `${KNOWLEDGE_ROOT}/${id}.md`,
  };
}

function serializeKnowledge(input: KnowledgeCaptureInput, updated: string): string {
  const type = input.type ?? "topic";
  const status = input.status ?? "reference";
  return [
    "---",
    `title: ${yamlScalar(input.title)}`,
    `id: ${input.id}`,
    `category: ${input.category}`,
    `type: ${type}`,
    `status: ${status}`,
    `updated: ${updated}`,
    `summary: ${yamlScalar(input.summary)}`,
    `tags: [${input.tags.map(yamlScalar).join(", ")}]`,
    `sources: [${input.sources.map(yamlScalar).join(", ")}]`,
    `related: [${(input.related ?? []).map(yamlScalar).join(", ")}]`,
    "---",
    "",
    `# ${input.title.trim()}`,
    "",
    input.summary.trim(),
    "",
    input.content.trim(),
    "",
    "## 来源",
    "",
    ...input.sources.map((source) => `- ${source}`),
    "",
  ].join("\n");
}

function validateCapture(input: KnowledgeCaptureInput): void {
  validateId(input.id);
  if (!CATEGORY_PATTERN.test(input.category)) throw new Error("Knowledge category must be a lowercase slug");
  if (input.id.split("/")[0] !== input.category) throw new Error("Knowledge ID must start with its category");
  if (input.title.trim().length === 0 || input.title.length > 160 || /[\r\n]/.test(input.title)) {
    throw new Error("Knowledge title must be 1-160 characters on one line");
  }
  if (input.summary.trim().length === 0 || input.summary.length > 1_000 || /[\r\n]/.test(input.summary)) {
    throw new Error("Knowledge summary must be 1-1000 characters on one line");
  }
  if (input.content.trim().length === 0 || Buffer.byteLength(input.content) > MAX_DOCUMENT_BYTES) {
    throw new Error(`Knowledge content must be non-empty and at most ${MAX_DOCUMENT_BYTES} bytes`);
  }
  if (input.tags.length > MAX_TAGS || input.tags.some((tag) => tag.trim().length === 0 || tag.length > 48 || /[\r\n,\[\]]/.test(tag))) {
    throw new Error(`Knowledge accepts at most ${MAX_TAGS} valid tags`);
  }
  if (input.sources.length === 0 || input.sources.length > MAX_SOURCES || input.sources.some((source) => !isHttpUrl(source))) {
    throw new Error(`Knowledge requires 1-${MAX_SOURCES} HTTP(S) source URLs`);
  }
  if (input.related?.some((related) => !ID_PATTERN.test(related))) throw new Error("Knowledge related IDs are invalid");
  const combined = `${input.title}\n${input.summary}\n${input.content}`;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(combined))) throw new Error("Knowledge content appears to contain a secret or credential");
}

function validateId(id: string): void {
  if (!ID_PATTERN.test(id) || id.endsWith("/README") || id.endsWith("/MOC") || id.startsWith("_meta/")) {
    throw new Error("Knowledge ID must be lowercase path segments separated by '/'");
  }
}

function parseMetadata(raw: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    metadata[key] = value;
  }
  return metadata;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.trim());
}

function firstParagraph(content: string): string {
  return content.split(/\n\s*\n/).find((part) => !part.trim().startsWith("#"))?.trim().slice(0, 1_000) || "";
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [])];
}

function score(document: KnowledgeDocument, terms: readonly string[], query: string): number {
  const title = `${document.title} ${document.id}`.toLowerCase();
  const tags = document.tags.join(" ").toLowerCase();
  const body = `${document.summary} ${document.content}`.toLowerCase();
  let value = title.includes(query) ? 12 : 0;
  for (const term of terms) {
    if (title.includes(term)) value += 6;
    if (tags.includes(term)) value += 4;
    if (body.includes(term)) value += 1;
  }
  return value;
}

function nextUpdated(previous?: string): string {
  const now = Date.now();
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(previousMs) && previousMs >= now ? previousMs + 1 : now).toISOString();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
