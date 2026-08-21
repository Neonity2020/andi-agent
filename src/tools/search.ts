import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool } from "./types";
import { readLimited, processEnvWithoutSecrets } from "./command";
import { requireRecord, requireString } from "./validation";
import { cancellationError, throwIfAborted } from "../runtime/abort";

export interface SearchCodeOptions {
  regex?: boolean;
  glob?: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export async function searchCode(
  cwd: string,
  query: string,
  options: SearchCodeOptions = {},
): Promise<{ results: string[]; truncated: boolean }> {
  throwIfAborted(options.signal);
  if (query.length === 0) throw new Error("Search query cannot be empty");
  if (query.includes("\0") || options.glob?.includes("\0")) throw new Error("Search input contains a null byte");
  const maxResults = options.maxResults ?? 100;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
    throw new Error("maxResults must be an integer from 1 to 500");
  }

  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    "5",
    "--glob",
    "!.git/**",
    "--glob",
    "!.andi-agent/**",
    "--glob",
    "!.memory/**",
    "--glob",
    "!node_modules/**",
  ];
  if (!options.regex) args.push("--fixed-strings");
  if (options.glob) args.push("--glob", options.glob);
  args.push("--", query, ".");

  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn(["rg", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: processEnvWithoutSecrets(),
    });
  } catch (error) {
    if (isMissingExecutable(error)) {
      return searchCodeWithoutRipgrep(cwd, query, options);
    }
    throw new Error(`Unable to start ripgrep: ${error instanceof Error ? error.message : String(error)}`);
  }
  let cancelled = false;
  const cancelProcess = (): void => {
    cancelled = true;
    process.kill();
  };
  options.signal?.addEventListener("abort", cancelProcess, { once: true });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readLimited(process.stdout as ReadableStream<Uint8Array>, 64 * 1024),
    readLimited(process.stderr as ReadableStream<Uint8Array>, 16 * 1024),
  ]);
  options.signal?.removeEventListener("abort", cancelProcess);
  if (cancelled) throw cancellationError(options.signal);
  if (exitCode !== 0 && exitCode !== 1) throw new Error(`ripgrep failed (${exitCode}): ${stderr.trim()}`);

  const allResults = stdout.split("\n").filter(Boolean);
  return { results: allResults.slice(0, maxResults), truncated: allResults.length > maxResults };
}

async function searchCodeWithoutRipgrep(
  cwd: string,
  query: string,
  options: SearchCodeOptions,
): Promise<{ results: string[]; truncated: boolean }> {
  const maxResults = options.maxResults ?? 100;
  const matcher = options.regex ? new RegExp(query, "g") : undefined;
  const results: string[] = [];
  let hasMore = false;

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (results.length >= maxResults) {
        hasMore = true;
        return;
      }
      if (entry.name === ".git" || entry.name === ".andi-agent" || entry.name === ".memory" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        if (hasMore) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const displayPath = relative(cwd, absolute);
      if (options.glob && !matchesGlob(options.glob, displayPath)) continue;
      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      let fileMatches = 0;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const column = matcher ? regexColumn(matcher, line) : line.indexOf(query);
        if (column < 0) continue;
        results.push(`${displayPath}:${lineIndex + 1}:${column + 1}:${line}`);
        fileMatches += 1;
        if (results.length >= maxResults) {
          hasMore = true;
          return;
        }
        if (fileMatches >= 5) break;
      }
    }
  };

  await visit(cwd);
  return { results, truncated: hasMore };
}

function regexColumn(matcher: RegExp, line: string): number {
  matcher.lastIndex = 0;
  const match = matcher.exec(line);
  return match?.index ?? -1;
}

function matchesGlob(pattern: string, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  const regex = new RegExp(`^(?:${expression}|(?:[^/]+/)*${expression})$`);
  return regex.test(normalized);
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && ("code" in error ? (error as NodeJS.ErrnoException).code === "ENOENT" : /not found|不存在/i.test(error.message));
}

export function createSearchTool(cwd: string): Tool {
  return {
    name: "search_code",
    description: "使用 ripgrep 搜索工作区源代码文本。结果排除 Git 元数据、依赖和 Agent 会话。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的文本或正则表达式" },
        regex: { type: "boolean", default: false },
        glob: { type: "string", description: "可选的文件 glob，例如 '*.ts'" },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const values = requireRecord(input);
      if (values.regex !== undefined && typeof values.regex !== "boolean") {
        throw new Error("Field 'regex' must be a boolean");
      }
      if (values.glob !== undefined && typeof values.glob !== "string") {
        throw new Error("Field 'glob' must be a string");
      }
      if (values.max_results !== undefined && !Number.isInteger(values.max_results)) {
        throw new Error("Field 'max_results' must be an integer");
      }
      const options: SearchCodeOptions = {};
      if (typeof values.regex === "boolean") options.regex = values.regex;
      if (typeof values.glob === "string") options.glob = values.glob;
      if (typeof values.max_results === "number") options.maxResults = values.max_results;
      if (context?.signal) options.signal = context.signal;
      return searchCode(cwd, requireString(values, "query"), options);
    },
  };
}
