import type { Tool } from "./types";
import { readLimited, processEnvWithoutSecrets } from "./command";
import { requireRecord, requireString } from "./validation";

export interface SearchCodeOptions {
  regex?: boolean;
  glob?: string;
  maxResults?: number;
}

export async function searchCode(
  cwd: string,
  query: string,
  options: SearchCodeOptions = {},
): Promise<{ results: string[]; truncated: boolean }> {
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
    throw new Error(`Unable to start ripgrep: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readLimited(process.stdout as ReadableStream<Uint8Array>, 64 * 1024),
    readLimited(process.stderr as ReadableStream<Uint8Array>, 16 * 1024),
  ]);
  if (exitCode !== 0 && exitCode !== 1) throw new Error(`ripgrep failed (${exitCode}): ${stderr.trim()}`);

  const allResults = stdout.split("\n").filter(Boolean);
  return { results: allResults.slice(0, maxResults), truncated: allResults.length > maxResults };
}

export function createSearchTool(cwd: string): Tool {
  return {
    name: "search_code",
    description: "Search workspace source text with ripgrep. Results exclude Git metadata, dependencies, and agent sessions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regular expression to search for" },
        regex: { type: "boolean", default: false },
        glob: { type: "string", description: "Optional file glob such as '*.ts'" },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input: unknown) {
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
      return searchCode(cwd, requireString(values, "query"), options);
    },
  };
}
