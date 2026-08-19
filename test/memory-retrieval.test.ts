import { describe, expect, test } from "bun:test";
import { rankMemoryDocuments, tokenizeMemoryText } from "../src/memory/retrieval";
import type { MemoryDocument } from "../src/memory/types";

function memory(id: string, title: string, tags: string[], content: string): MemoryDocument {
  return { id, title, tags, content, updated: "2026-08-19T00:00:00.000Z", path: `.memory/${id}.md` };
}

describe("memory retrieval", () => {
  const documents = [
    memory("style", "TypeScript Coding Style", ["typescript", "conventions"], "Use two spaces and semicolons."),
    memory("sources", "新闻信源偏好", ["新闻", "AI"], "国际新闻优先参考 Reuters，技术新闻参考官方博客。"),
    memory("release", "Release Checklist", ["release"], "Run tests and typecheck before push."),
  ];

  test("tokenizes English and Chinese queries", () => {
    expect(tokenizeMemoryText("TypeScript conventions")).toContain("typescript");
    expect(tokenizeMemoryText("国际新闻来源")).toContain("国际");
  });

  test("ranks title and tag matches above incidental body matches", () => {
    const matches = rankMemoryDocuments(documents, "TypeScript conventions");
    expect(matches[0]?.id).toBe("style");
    expect(matches[0]?.score).toBeGreaterThan(5);
  });

  test("recalls Chinese memory and returns no unrelated filler", () => {
    expect(rankMemoryDocuments(documents, "国际新闻信源")[0]?.id).toBe("sources");
    expect(rankMemoryDocuments(documents, "database migration rollback")).toEqual([]);
  });

  test("uses stable ID ordering for equal scores and validates limits", () => {
    const equal = [memory("b", "Alpha", [], "same token"), memory("a", "Alpha", [], "same token")];
    expect(rankMemoryDocuments(equal, "Alpha").map((item) => item.id)).toEqual(["a", "b"]);
    expect(() => rankMemoryDocuments(documents, "style", { limit: 0 })).toThrow("1-20");
  });
});
