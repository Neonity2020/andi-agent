import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, parseMemoryDocument } from "../src/memory/store";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; workspace: Workspace; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "andi-agent-memory-"));
  temporaryDirectories.push(root);
  const workspace = await Workspace.create(root);
  return { root, workspace, store: new MemoryStore(workspace) };
}

describe("MemoryStore", () => {
  test("creates, reads, searches, and concurrency-safely updates Markdown memory", async () => {
    const { store } = await setup();
    const [created, second] = await Promise.all([
      store.remember({
        id: "coding-style",
        title: "Coding Style",
        tags: ["typescript", "style"],
        content: "Use two-space indentation and double quotes.",
      }),
      store.remember({
        id: "release-process",
        title: "Release Process",
        tags: ["release"],
        content: "Run the complete test suite before publishing.",
      }),
    ]);

    expect(created.action).toBe("created");
    expect(second.action).toBe("created");
    const memory = await store.read("coding-style");
    expect(memory.content).toContain("two-space");
    expect((await store.search("TypeScript style"))[0]?.id).toBe("coding-style");
    expect(await store.list()).toHaveLength(2);

    await expect(
      store.remember({ ...memory, content: "Use tabs." }),
    ).rejects.toThrow("provide expected_updated");
    await expect(
      store.remember({ ...memory, expectedUpdated: "stale", content: "Use tabs." }),
    ).rejects.toThrow("changed since it was read");
    const updated = await store.remember({
      ...memory,
      expectedUpdated: memory.updated,
      content: "Use two-space indentation and semicolons.",
    });
    expect(updated.action).toBe("updated");
    expect((await store.read("coding-style")).content).toContain("semicolons");
  });

  test("archives recoverably and protects README", async () => {
    const { root, store } = await setup();
    await store.remember({ id: "obsolete", title: "Old Fact", tags: ["old"], content: "No longer used." });
    const archived = await store.archive("obsolete");

    await expect(store.read("obsolete")).rejects.toThrow("does not exist");
    expect(await readFile(join(root, archived.archivedPath), "utf8")).toContain("Old Fact");
    await expect(
      store.remember({ id: "readme", title: "No", tags: [], content: "Cannot replace index." }),
    ).rejects.toThrow("README.md is reserved");
  });

  test("rejects unsafe IDs, oversized content, credentials, and symlink roots", async () => {
    const { root, store } = await setup();
    await expect(
      store.remember({ id: "../escape", title: "Escape", tags: [], content: "no" }),
    ).rejects.toThrow("lowercase slug");
    await expect(
      store.remember({ id: "huge", title: "Huge", tags: [], content: "x".repeat(33_000) }),
    ).rejects.toThrow("byte limit");
    await expect(
      store.remember({
        id: "secret",
        title: "Secret",
        tags: [],
        content: "AGNES_API_KEY=secret-value-that-must-not-be-stored",
      }),
    ).rejects.toThrow("secret or credential");

    const outside = await mkdtemp(join(tmpdir(), "andi-agent-memory-outside-"));
    temporaryDirectories.push(outside);
    await rm(join(root, ".memory"), { recursive: true, force: true });
    await writeFile(join(outside, "escaped.md"), "outside workspace\n");
    await symlink(outside, join(root, ".memory"));
    await expect(store.list()).rejects.toThrow("must not be a symlink");
    await expect(store.read("escaped")).rejects.toThrow("must not be a symlink");
  });

  test("parses legacy Markdown and builds a bounded context", async () => {
    const { root, store } = await setup();
    await mkdir(join(root, ".memory"));
    await writeFile(join(root, ".memory", "legacy.md"), "Legacy preference about concise answers.\n");

    expect(parseMemoryDocument("legacy", "plain body")).toMatchObject({
      id: "legacy",
      title: "legacy",
      tags: [],
      content: "plain body",
    });
    const context = await store.buildContext("concise preference", undefined, 300);
    expect(context.ids).toEqual(["legacy"]);
    expect(context.content).toContain("BEGIN WORKSPACE MEMORY");
    expect(context.chars).toBeLessThanOrEqual(300);
  });
});
