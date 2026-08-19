import type { Tool } from "./types";
import { requireRecord, requireString, requireStringArray } from "./validation";
import { cancellationError, throwIfAborted } from "../runtime/abort";

const APPROVED_SCRIPTS = new Set(["test", "typecheck", "lint", "check", "build"]);

export interface CommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export type CommandApprover = (command: readonly string[], signal?: AbortSignal) => Promise<boolean>;

export interface CommandToolOptions {
  approver?: CommandApprover;
}

export function isCommandAllowed(program: string, args: readonly string[]): boolean {
  if (program === "bun" || program === "npm") {
    if (args.length === 1 && args[0] === "test") return true;
    return args.length === 2 && args[0] === "run" && APPROVED_SCRIPTS.has(args[1] ?? "");
  }
  return program === "tsc" && args.length === 1 && args[0] === "--noEmit";
}

export async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytesKept = 0;
  let truncated = false;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const remaining = limit - bytesKept;
    if (remaining > 0) {
      const kept = chunk.value.subarray(0, remaining);
      output += decoder.decode(kept, { stream: true });
      bytesKept += kept.byteLength;
    }
    if (chunk.value.byteLength > remaining) truncated = true;
  }
  output += decoder.decode();
  return truncated ? `${output}\n...[output truncated at ${limit} bytes]` : output;
}

export async function runCommand(
  cwd: string,
  program: string,
  args: readonly string[],
  timeoutMs: number,
  outputLimit = 64 * 1024,
  approver?: CommandApprover,
  signal?: AbortSignal,
): Promise<CommandResult> {
  throwIfAborted(signal);
  if (program.length === 0 || program.includes("\0") || args.some((argument) => argument.includes("\0"))) {
    throw new Error("Command contains an invalid empty program or null byte");
  }

  const command = [program, ...args];
  if (!isCommandAllowed(program, args)) {
    if (!approver) throw new Error(`Command requires approval: ${JSON.stringify(command)}`);
    const approved = await approver(command, signal);
    throwIfAborted(signal);
    if (!approved) throw new Error(`Command was rejected by the user: ${JSON.stringify(command)}`);
  }
  throwIfAborted(signal);

  const process = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: processEnvWithoutSecrets(),
  });
  let timedOut = false;
  let cancelled = false;
  const cancelProcess = (): void => {
    cancelled = true;
    process.kill();
  };
  signal?.addEventListener("abort", cancelProcess, { once: true });
  const timer = setTimeout(() => {
    if (!cancelled) {
      timedOut = true;
      process.kill();
    }
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readLimited(process.stdout, outputLimit),
      readLimited(process.stderr, outputLimit),
    ]);
    return { command, exitCode, stdout, stderr, timedOut, cancelled };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancelProcess);
  }
}

export function processEnvWithoutSecrets(): Record<string, string> {
  const allowed = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"];
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export function createCommandTool(cwd: string, options: CommandToolOptions = {}): Tool {
  return {
    name: "run_command",
    description:
      "Run an approved test, typecheck, build, or lint command in the workspace without a shell. Only use for project verification tasks (e.g. bun test, npm test, tsc --noEmit). NEVER use for executing ad-hoc scripts (bun -e, node -e), previewing markdown/tables, or calculating values. Use dedicated Git tools for Git operations.",
    parameters: {
      type: "object",
      properties: {
        program: { type: "string", description: "Executable name or path" },
        args: { type: "array", items: { type: "string" } },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 120, default: 30 },
      },
      required: ["program", "args"],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const values = requireRecord(input);
      const timeout = values.timeout_seconds === undefined ? 30 : values.timeout_seconds;
      if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 120) {
        throw new Error("Field 'timeout_seconds' must be an integer from 1 to 120");
      }
      const program = requireString(values, "program");
      const args = requireStringArray(values, "args");
      const result = options.approver
        ? await runCommand(
            cwd,
            program,
            args,
            (timeout as number) * 1_000,
            64 * 1024,
            options.approver,
            context?.signal,
          )
        : await runCommand(cwd, program, args, (timeout as number) * 1_000, 64 * 1024, undefined, context?.signal);
      if (result.cancelled) throw cancellationError(context?.signal);
      return result;
    },
  };
}
