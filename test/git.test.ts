import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Tool } from "../src/tools/types";
import { createGitTools } from "../src/tools/git";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text());
}

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

describe("Git tools", () => {
  test("shows diffs, then stages and commits only after approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-agent-git-"));
    temporaryDirectories.push(root);
    await git(root, "init");
    await git(root, "config", "user.name", "Agent Test");
    await git(root, "config", "user.email", "agent@example.com");
    const workspace = await Workspace.create(root);
    await workspace.write("hello.txt", "hello\n");
    const approvals: string[][] = [];
    const tools = createGitTools(workspace, {
      async approver(command) {
        approvals.push([...command]);
        return true;
      },
    });

    const status = (await findTool(tools, "git_status").execute({})) as { stdout: string };
    expect(status.stdout).toContain("hello.txt");
    await findTool(tools, "git_stage").execute({ paths: ["hello.txt"] });
    const diff = (await findTool(tools, "git_diff").execute({ staged: true })) as { stdout: string };
    expect(diff.stdout).toContain("+hello");
    await findTool(tools, "git_commit").execute({ message: "test: initial commit" });

    expect(approvals).toEqual([
      ["git", "add", "--", "hello.txt"],
      ["git", "commit", "-m", "test: initial commit"],
    ]);
    const finalStatus = (await findTool(tools, "git_status").execute({})) as { stdout: string };
    expect(finalStatus.stdout).toBe("");
  });

  test("refuses Git writes when no approver is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-agent-git-"));
    temporaryDirectories.push(root);
    await git(root, "init");
    const tools = createGitTools(await Workspace.create(root));

    expect(findTool(tools, "git_stage").execute({ paths: ["file.txt"] })).rejects.toThrow("requires interactive");
    expect(findTool(tools, "git_stage").execute({ paths: [":(glob)**"] })).rejects.toThrow("pathspec magic");
    expect(findTool(tools, "git_stage").execute({ paths: ["."] })).rejects.toThrow("not allowed");
  });
});
