import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/knowledge/store";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; store: KnowledgeStore }> {
  const root = await mkdtemp(join(tmpdir(), "andi-agent-knowledge-"));
  temporaryDirectories.push(root);
  return { root, store: new KnowledgeStore(await Workspace.create(root)) };
}

describe("KnowledgeStore", () => {
  test("captures atomic notes, updates the MOC, and searches them", async () => {
    const { root, store } = await setup();
    const created = await store.capture({
      id: "concepts/prompt-caching",
      title: "Prompt 缓存",
      category: "concepts",
      type: "concept",
      status: "reference",
      summary: "稳定 Prompt 前缀可以被 Provider 复用。",
      tags: ["prompt", "cache"],
      sources: ["https://example.com/prompt-cache"],
      content: "把稳定内容放在前面，把动态上下文放在后面。",
    });

    expect(created.action).toBe("created");
    expect(created.mocUpdated).toBeTrue();
    expect((await store.read("concepts/prompt-caching")).sources).toEqual(["https://example.com/prompt-cache"]);
    expect((await store.search("缓存"))[0]?.id).toBe("concepts/prompt-caching");
    expect(await readFile(join(root, "kb", "MOC.md"), "utf8")).toContain("concepts/prompt-caching");
  });

  test("requires an expected timestamp for updates and rejects secrets", async () => {
    const { store } = await setup();
    const created = await store.capture({
      id: "providers/example",
      title: "Example Provider",
      category: "providers",
      summary: "A provider reference.",
      tags: ["provider"],
      sources: ["https://example.com/docs"],
      content: "Use the documented endpoint.",
    });

    await expect(store.capture({
      id: "providers/example",
      title: "Example Provider",
      category: "providers",
      summary: "An update.",
      tags: ["provider"],
      sources: ["https://example.com/docs"],
      content: "Updated facts.",
    })).rejects.toThrow("expected_updated");

    await expect(store.capture({
      id: "concepts/secret",
      title: "Secret",
      category: "concepts",
      summary: "No.",
      tags: [],
      sources: ["https://example.com/docs"],
      content: "AGNES_API_KEY=secret-value-that-must-not-be-stored",
    })).rejects.toThrow("secret");

    const updated = await store.capture({
      id: "providers/example",
      title: "Example Provider",
      category: "providers",
      summary: "An update.",
      tags: ["provider"],
      sources: ["https://example.com/docs"],
      content: "Updated facts.",
      expectedUpdated: created.document.updated,
    });
    expect(updated.action).toBe("updated");
  });
});
