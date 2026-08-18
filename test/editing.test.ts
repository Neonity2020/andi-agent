import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool } from "../src/tools/editing";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(content: string): Promise<{ workspace: Workspace; tool: ReturnType<typeof createEditTool> }> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-edit-"));
  temporaryDirectories.push(directory);
  const workspace = await Workspace.create(directory);
  await workspace.write("sample.ts", content);
  return { workspace, tool: createEditTool(workspace) };
}

describe("edit_file", () => {
  test("replaces one exact text block", async () => {
    const { workspace, tool } = await setup("const answer = 41;\n");

    expect(
      await tool.execute({ path: "sample.ts", old_text: "answer = 41", new_text: "answer = 42" }),
    ).toEqual({ edited: "sample.ts" });
    expect(await workspace.read("sample.ts")).toBe("const answer = 42;\n");
  });

  test("rejects missing and ambiguous text", async () => {
    const { tool } = await setup("same\nsame\n");

    expect(tool.execute({ path: "sample.ts", old_text: "missing", new_text: "new" })).rejects.toThrow(
      "not found",
    );
    expect(tool.execute({ path: "sample.ts", old_text: "same", new_text: "new" })).rejects.toThrow(
      "more than once",
    );
  });
});
