import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/tui/markdown";
import { createTheme } from "../src/tui/theme";

const theme = createTheme(false);

describe("renderMarkdown", () => {
  test("wraps plain paragraphs to the width", () => {
    expect(renderMarkdown("the quick brown fox jumps", 10, theme)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  test("renders fenced code with a bar prefix and no fence markers", () => {
    const output = renderMarkdown("before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter", 20, theme);
    expect(output).toEqual(["before", "", "│ const a = 1;", "│ const b = 2;", "", "after"]);
  });

  test("wraps long code lines inside the block", () => {
    const output = renderMarkdown("```\nabcdefgh ijklmn\n```", 10, theme);
    expect(output).toEqual(["│ abcdefgh", "│ ijklmn"]);
  });

  test("bolds headings and keeps them wrapped", () => {
    const styled = createTheme(true);
    const output = renderMarkdown("# Title here", 20, styled);
    expect(output).toEqual(["\x1b[1mTitle here\x1b[0m"]);
  });

  test("renders bullets with hanging indent", () => {
    const output = renderMarkdown("- first item\n- second item", 12, theme);
    expect(output).toEqual(["• first item", "• second", "  item"]);
  });

  test("keeps ordered-list markers", () => {
    const output = renderMarkdown("1. one\n2. two", 20, theme);
    expect(output).toEqual(["1. one", "2. two"]);
  });

  test("applies inline bold and code styling per line", () => {
    const styled = createTheme(true);
    const output = renderMarkdown("use **bold** and `code` here", 40, styled);
    expect(output[0]).toContain("\x1b[1mbold\x1b[0m");
    expect(output[0]).toContain(`\x1b[38;5;${styled.colors.info}mcode\x1b[0m`);
    expect(output[0]).not.toContain("**");
  });

  test("collapses repeated blank lines and trims edges", () => {
    expect(renderMarkdown("\n\na\n\n\nb\n\n", 20, theme)).toEqual(["a", "", "b"]);
  });

  test("wraps CJK text to cell width", () => {
    expect(renderMarkdown("你好世界测试", 8, theme)).toEqual(["你好世界", "测试"]);
  });

  test("produces no escape codes when color is disabled", () => {
    const output = renderMarkdown("# h\n\n- b\n\n`c`", 20, theme);
    expect(output.join("\n")).not.toContain("\x1b");
  });

  test("rejects widths too small to render", () => {
    expect(() => renderMarkdown("x", 2, theme)).toThrow("at least 4");
  });
});
