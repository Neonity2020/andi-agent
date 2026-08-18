import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<Workspace> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-"));
  temporaryDirectories.push(directory);
  return Workspace.create(directory);
}

describe("Workspace", () => {
  test("writes, reads, and lists files", async () => {
    const workspace = await createWorkspace();
    await workspace.write("src/hello.ts", "export const hello = 'world';\n");

    expect(await workspace.read("src/hello.ts")).toContain("world");
    expect(await workspace.list()).toEqual(["src/hello.ts"]);
  });

  test("rejects paths outside the workspace", async () => {
    const workspace = await createWorkspace();

    expect(workspace.read("../secret.txt")).rejects.toThrow("escapes workspace");
    expect(workspace.write("../../secret.txt", "nope")).rejects.toThrow("escapes workspace");
    expect(workspace.write(join(tmpdir(), "secret.txt"), "nope")).rejects.toThrow("escapes workspace");
  });

  test("refuses to follow a directory symlink when writing", async () => {
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "andi-agent-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, join(workspace.root, "linked"));

    expect(workspace.write("linked/secret.txt", "nope")).rejects.toThrow("escapes workspace");
  });
});
