import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store";
import { createMemoryTools } from "../src/tools/memory";
import { ToolRegistry } from "../src/tools/registry";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(writable = true): Promise<ToolRegistry> {
  const root = await mkdtemp(join(tmpdir(), "andi-agent-memory-tools-"));
  temporaryDirectories.push(root);
  const store = new MemoryStore(await Workspace.create(root));
  return new ToolRegistry(createMemoryTools(store, { writable }));
}

describe("memory tools", () => {
  test("registers four interactive tools and only two scheduled-safe tools", async () => {
    expect((await setup()).definitions().map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_read",
      "memory_remember",
      "memory_archive",
    ]);
    expect((await setup(false)).definitions().map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_read",
    ]);
  });

  test("creates, searches, reads, and archives through model-facing schemas", async () => {
    const registry = await setup();
    const created = await registry.execute(
      "memory_remember",
      JSON.stringify({ id: "preference", title: "User Preference", tags: ["style"], content: "Be concise." }),
    );
    expect(created).toMatchObject({ ok: true, value: { action: "created" } });
    const searched = await registry.execute("memory_search", JSON.stringify({ query: "concise style" }));
    expect(searched).toMatchObject({ ok: true, value: { matches: [{ id: "preference" }] } });
    const read = await registry.execute("memory_read", JSON.stringify({ id: "preference" }));
    expect(read).toMatchObject({ ok: true, value: { content: "Be concise." } });
    expect(await registry.execute("memory_archive", JSON.stringify({ id: "preference" }))).toMatchObject({
      ok: true,
      value: { id: "preference" },
    });
  });

  test("validates tool arguments", async () => {
    const registry = await setup();
    expect(await registry.execute("memory_search", JSON.stringify({ query: "x", limit: 0 }))).toMatchObject({
      ok: false,
    });
    expect(
      await registry.execute(
        "memory_remember",
        JSON.stringify({ id: "note", title: "Note", tags: "wrong", content: "content" }),
      ),
    ).toMatchObject({ ok: false });
  });
});
