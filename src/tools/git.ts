import type { CommandApprover, CommandResult } from "./command";
import { processEnvWithoutSecrets, readLimited, runCommand } from "./command";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool } from "./types";
import { requireRecord, requireString, requireStringArray } from "./validation";
import type { Workspace } from "./workspace";

export interface GitToolOptions {
  approver?: CommandApprover;
}

async function runGitRead(cwd: string, args: readonly string[]): Promise<CommandResult> {
  const command = ["git", "-c", "core.fsmonitor=false", "--no-pager", ...args];
  const process = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: processEnvWithoutSecrets(),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readLimited(process.stdout, 128 * 1024),
    readLimited(process.stderr, 32 * 1024),
  ]);
  return { command, exitCode, stdout, stderr, timedOut: false };
}

function requirePaths(values: Record<string, unknown>, workspace: Workspace): string[] {
  const paths = requireStringArray(values, "paths");
  if (paths.length === 0) throw new Error("Field 'paths' must contain at least one explicit path");
  for (const path of paths) {
    if (path === ".") throw new Error("Path '.' is not allowed; list files explicitly");
    if (path.startsWith(":")) throw new Error("Git pathspec magic is not allowed");
    workspace.assertToolPath(path);
  }
  return paths;
}

async function requireStagePaths(values: Record<string, unknown>, workspace: Workspace): Promise<string[]> {
  const paths = requirePaths(values, workspace);
  for (const path of paths) {
    try {
      const metadata = await lstat(resolve(workspace.root, path));
      if (metadata.isDirectory()) throw new Error(`Directory staging is not allowed: ${path}`);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
      // Missing paths are allowed so an explicitly named deletion can be staged.
    }
  }
  return paths;
}

export function createGitTools(workspace: Workspace, options: GitToolOptions = {}): Tool[] {
  return [
    {
      name: "git_status",
      description: "Show the concise Git working tree status without modifying it.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(input: unknown) {
        requireRecord(input);
        return runGitRead(workspace.root, ["status", "--short"]);
      },
    },
    {
      name: "git_diff",
      description: "Show a safe Git diff for the working tree or staged changes.",
      parameters: {
        type: "object",
        properties: {
          staged: { type: "boolean", default: false },
          paths: { type: "array", items: { type: "string" }, description: "Optional explicit paths" },
        },
        additionalProperties: false,
      },
      async execute(input: unknown) {
        const values = requireRecord(input);
        if (values.staged !== undefined && typeof values.staged !== "boolean") {
          throw new Error("Field 'staged' must be a boolean");
        }
        const args = ["diff", "--no-ext-diff", "--no-textconv"];
        if (values.staged === true) args.push("--cached");
        if (values.paths !== undefined) args.push("--", ...requirePaths(values, workspace));
        return runGitRead(workspace.root, args);
      },
    },
    {
      name: "git_stage",
      description: "Stage explicitly listed workspace files after user approval.",
      parameters: {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" } } },
        required: ["paths"],
        additionalProperties: false,
      },
      async execute(input: unknown) {
        const paths = await requireStagePaths(requireRecord(input), workspace);
        if (!options.approver) throw new Error("git_stage requires interactive command approval");
        return runCommand(workspace.root, "git", ["add", "--", ...paths], 30_000, 64 * 1024, options.approver);
      },
    },
    {
      name: "git_commit",
      description: "Commit only the currently staged changes after user approval. Does not push.",
      parameters: {
        type: "object",
        properties: { message: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["message"],
        additionalProperties: false,
      },
      async execute(input: unknown) {
        const message = requireString(requireRecord(input), "message").trim();
        if (message.length === 0 || message.length > 200 || message.includes("\n")) {
          throw new Error("Commit message must be one non-empty line of at most 200 characters");
        }
        if (!options.approver) throw new Error("git_commit requires interactive command approval");
        return runCommand(workspace.root, "git", ["commit", "-m", message], 120_000, 64 * 1024, options.approver);
      },
    },
  ];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
