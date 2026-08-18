import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tool } from "./types";
import { requireRecord, requireString } from "./validation";
import { throwIfAborted } from "../runtime/abort";

interface PathInput {
  path: string;
}

interface WriteInput extends PathInput {
  content: string;
}

export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<Workspace> {
    const canonicalRoot = await realpath(resolve(root));
    return new Workspace(canonicalRoot);
  }

  #assertInside(candidate: string): void {
    const pathFromRoot = relative(this.root, candidate);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error(`Path escapes workspace: ${candidate}`);
    }
  }

  #lexicalPath(inputPath: string): string {
    if (inputPath.length === 0) throw new Error("Path cannot be empty");
    const candidate = resolve(this.root, inputPath);
    this.#assertInside(candidate);
    return candidate;
  }

  assertToolPath(inputPath: string): void {
    const candidate = this.#lexicalPath(inputPath);
    const pathFromRoot = relative(this.root, candidate);
    if (pathFromRoot === ".andi-agent" || pathFromRoot.startsWith(`.andi-agent${sep}`)) {
      throw new Error("The .andi-agent directory is reserved for internal state");
    }
  }

  async #existingPath(inputPath: string): Promise<string> {
    const candidate = this.#lexicalPath(inputPath);
    const canonical = await realpath(candidate);
    this.#assertInside(canonical);
    return canonical;
  }

  async read(inputPath: string): Promise<string> {
    return readFile(await this.#existingPath(inputPath), "utf8");
  }

  async write(inputPath: string, content: string): Promise<void> {
    const target = this.#lexicalPath(inputPath);
    const parent = dirname(target);

    // Validate the nearest existing ancestor before mkdir can follow a symlink.
    let existingAncestor = parent;
    while (true) {
      try {
        await lstat(existingAncestor);
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        const next = dirname(existingAncestor);
        if (next === existingAncestor) throw error;
        existingAncestor = next;
      }
    }
    this.#assertInside(await realpath(existingAncestor));

    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    this.#assertInside(canonicalParent);
    const safeTarget = join(canonicalParent, basename(target));

    try {
      const metadata = await lstat(safeTarget);
      if (metadata.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${inputPath}`);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    await writeFile(safeTarget, content, "utf8");
  }

  async list(inputPath = ".", limit = 200): Promise<string[]> {
    const start = await this.#existingPath(inputPath);
    const output: string[] = [];

    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (output.length >= limit) return;
        if (entry.name === ".git" || entry.name === ".andi-agent" || entry.name === "node_modules") continue;
        const absolute = join(directory, entry.name);
        const display = relative(this.root, absolute);
        if (entry.isSymbolicLink()) {
          output.push(`${display} -> [symlink]`);
        } else if (entry.isDirectory()) {
          await visit(absolute);
        } else {
          output.push(display);
        }
      }
    };

    await visit(start);
    return output;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function createWorkspaceTools(workspace: Workspace): Tool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path" } },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        const values = requireRecord(input) as unknown as PathInput;
        const path = requireString(values as unknown as Record<string, unknown>, "path");
        workspace.assertToolPath(path);
        return { content: await workspace.read(path) };
      },
    },
    {
      name: "list_files",
      description: "Recursively list files inside a workspace directory (up to 200 results).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path; defaults to '.'" } },
        additionalProperties: false,
      },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        const values = requireRecord(input);
        const path = values.path === undefined ? "." : requireString(values, "path");
        workspace.assertToolPath(path);
        return { files: await workspace.list(path) };
      },
    },
    {
      name: "write_file",
      description: "Create or replace a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "Complete new file content" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(input: unknown, context) {
        throwIfAborted(context?.signal);
        const values = requireRecord(input) as unknown as WriteInput;
        const record = values as unknown as Record<string, unknown>;
        const path = requireString(record, "path");
        workspace.assertToolPath(path);
        await workspace.write(path, requireString(record, "content"));
        throwIfAborted(context?.signal);
        return { written: values.path };
      },
    },
  ];
}
