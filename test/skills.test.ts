import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManager } from "../src/skills/manager";

async function createSkill(root: string, scope: ".agents" | ".claude", name: string, content: string): Promise<void> {
  const directory = join(root, scope, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content);
}

describe("SkillManager", () => {
  test("discovers the shared .agents format and invokes a skill with arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-skills-"));
    try {
      await createSkill(
        root,
        ".agents",
        "code-review",
        `---
name: code-review
description: Review code for correctness and tests
when_to_use: Use when reviewing a diff or implementation
---
Review the requested change carefully.
Argument: $ARGUMENTS
`,
      );
      const manager = await SkillManager.load(root, { includeUserSkills: false });

      expect(manager.list().map((skill) => skill.name)).toEqual(["code-review"]);
      const invocation = await manager.parseInvocation("/code-review focus on security");
      expect(invocation?.prompt).toContain("focus on security");
      expect(invocation?.prompt).toContain("SKILL: code-review");
      expect(await manager.contextForTask("Please review this code and its tests")).toContain(
        "Review the requested change carefully.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supports Claude project skills and lets project skills override user skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-skills-project-"));
    const userHome = await mkdtemp(join(tmpdir(), "andi-skills-user-"));
    try {
      await createSkill(root, ".claude", "deploy", "---\nname: deploy\ndescription: Project deployment workflow\n---\nproject");
      await mkdir(join(userHome, ".agents", "skills", "deploy"), { recursive: true });
      await writeFile(
        join(userHome, ".agents", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: User deployment workflow\n---\nuser",
      );
      const manager = await SkillManager.load(root, { userHome });

      expect(manager.find("deploy")?.body).toBe("project");
      expect(manager.find("deploy")?.source).toBe("project");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(userHome, { recursive: true, force: true });
    }
  });

  test("keeps disable-model-invocation skills out of automatic matching", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-skills-manual-"));
    try {
      await createSkill(
        root,
        ".agents",
        "release",
        "---\nname: release\ndescription: Release the application\ndisable-model-invocation: true\n---\nrelease steps",
      );
      const manager = await SkillManager.load(root, { includeUserSkills: false });

      expect(await manager.contextForTask("Please release the application")).toBe("");
      expect((await manager.parseInvocation("/release"))?.prompt).toContain("release steps");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expands Claude dynamic context through the supplied command runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-skills-context-"));
    try {
      await createSkill(
        root,
        ".claude",
        "changes",
        "---\nname: changes\ndescription: Summarize current changes\n---\nCurrent diff:\n!`git diff --stat`",
      );
      const calls: Array<{ command: string; cwd: string }> = [];
      const manager = await SkillManager.load(root, {
        includeUserSkills: false,
        executeCommand: async (command, cwd) => {
          calls.push({ command, cwd });
          return "changed files";
        },
      });

      expect((await manager.parseInvocation("/changes"))?.prompt).toContain("changed files");
      expect(calls).toEqual([{ command: "git diff --stat", cwd: root }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
