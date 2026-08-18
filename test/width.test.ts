import { describe, expect, test } from "bun:test";
import { graphemes, padEndWidth, textWidth, truncateToWidth, wrapText } from "../src/tui/width";

describe("textWidth", () => {
  test("measures terminal cells for ASCII, CJK, and emoji", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("你好")).toBe(4);
    expect(textWidth("你a")).toBe(3);
    expect(textWidth("👍")).toBe(2);
    expect(textWidth("")).toBe(0);
  });
});

describe("graphemes", () => {
  test("keeps combining marks and emoji clusters intact", () => {
    expect(graphemes("e\u0301")).toEqual(["e\u0301"]);
    expect(graphemes("你好")).toEqual(["你", "好"]);
  });
});

describe("padEndWidth", () => {
  test("pads to a cell-width budget", () => {
    expect(padEndWidth("你", 5)).toBe("你   ");
    expect(padEndWidth("ab", 5)).toBe("ab   ");
  });

  test("never extends text already at or over budget", () => {
    expect(padEndWidth("你好", 3)).toBe("你好");
    expect(padEndWidth("abc", 2)).toBe("abc");
  });
});

describe("truncateToWidth", () => {
  test("keeps short text untouched", () => {
    expect(truncateToWidth("abc", 5)).toBe("abc");
  });

  test("fits CJK text with an in-budget ellipsis", () => {
    expect(truncateToWidth("你好世界", 5)).toBe("你好…");
    expect(truncateToWidth("你好世界", 4)).toBe("你…");
    expect(truncateToWidth("abcdefghij", 5)).toBe("abcd…");
  });

  test("falls back to a lone ellipsis when only it fits", () => {
    expect(truncateToWidth("ab", 1)).toBe("…");
  });
});

describe("wrapText", () => {
  test("wraps ASCII on spaces only", () => {
    expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  test("preserves explicit newlines", () => {
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
  });

  test("wraps CJK text anywhere and mixes with ASCII words", () => {
    expect(wrapText("你好世界", 6)).toEqual(["你好世", "界"]);
    expect(wrapText("你好 world", 6)).toEqual(["你好", "world"]);
  });

  test("hard-splits unbreakable tokens wider than the budget", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("https://example.invalid/very/long/path", 12)).toEqual([
      "https://exam",
      "ple.invalid/",
      "very/long/pa",
      "th",
    ]);
  });

  test("drops the space at a wrap point", () => {
    expect(wrapText("aa bb", 2)).toEqual(["aa", "bb"]);
  });

  test("rejects non-positive widths", () => {
    expect(() => wrapText("x", 0)).toThrow("positive integer");
  });

  test("returns a single blank line for blank input", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });
});
