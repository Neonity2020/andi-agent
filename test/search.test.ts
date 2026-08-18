import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchCode } from "../src/tools/search";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("searchCode", () => {
  test("finds source text while excluding dependencies and sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-agent-search-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".andi-agent", "sessions"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "const uniqueNeedle = true;\n");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "uniqueNeedle\n");
    await writeFile(join(root, ".andi-agent", "sessions", "secret.json"), "uniqueNeedle\n");

    const result = await searchCode(root, "uniqueNeedle");

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toContain("src/main.ts");
    expect(result.truncated).toBeFalse();
  });

  test("supports regex and result truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "andi-agent-search-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "one.txt"), "item1\nitem2\n");

    const result = await searchCode(root, "item[0-9]", { regex: true, maxResults: 1 });

    expect(result.results).toHaveLength(1);
    expect(result.truncated).toBeTrue();
  });
});
