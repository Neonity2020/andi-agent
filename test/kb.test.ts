import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "kb");

describe("LLM wiki", () => {
  test("keeps provider notes atomic and metadata-complete", async () => {
    const files = (await readdir(join(root, "providers"))).filter((file) => file.endsWith(".md")).sort();
    const ids = new Set<string>();
    for (const file of files) {
      const content = await readFile(join(root, "providers", file), "utf8");
      const frontMatter = content.match(/^---\n([\s\S]*?)\n---/m)?.[1] ?? "";
      const id = frontMatter.match(/^id:\s*(\S+)$/m)?.[1];
      expect(id).toBe(file.slice(0, -3));
      expect(ids.has(id!)).toBeFalse();
      ids.add(id!);
      for (const field of ["title", "category", "type", "status", "proto", "updated", "source", "related"]) {
        expect(frontMatter).toMatch(new RegExp(`^${field}:`, "m"));
      }
    }
    expect(files).toContain("minimax.md");
  });

  test("keeps the MOC synchronized with provider notes", async () => {
    const moc = await readFile(join(root, "MOC.md"), "utf8");
    const files = (await readdir(join(root, "providers"))).filter((file) => file.endsWith(".md"));
    for (const file of files) expect(moc).toContain(`providers/${file}`);
  });

  test("documents progressive disclosure instead of whole-wiki loading", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toContain("先读取 `kb/README.md`");
    expect(readme).toContain("只读取对应的 `kb/providers/<id>.md`");
    expect(readme).toContain("把整本知识库一次性拼进 system prompt");
  });
});
