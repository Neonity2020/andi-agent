import { describe, expect, test } from "bun:test";
import {
  createTextStyle,
  cursorToColumn,
  cursorUp,
  disableBracketedPaste,
  enableBracketedPaste,
  eraseLineAll,
  eraseScreenBelow,
  hideCursor,
  showCursor,
} from "../src/tui/ansi";

describe("createTextStyle", () => {
  test("wraps text in SGR sequences when enabled", () => {
    const style = createTextStyle(true);
    expect(style.dim("x")).toBe("\x1b[2mx\x1b[0m");
    expect(style.bold("x")).toBe("\x1b[1mx\x1b[0m");
    expect(style.italic("x")).toBe("\x1b[3mx\x1b[0m");
    expect(style.fg(39, "x")).toBe("\x1b[38;5;39mx\x1b[0m");
  });

  test("returns plain text when disabled", () => {
    const style = createTextStyle(false);
    expect(style.dim("x")).toBe("x");
    expect(style.bold("x")).toBe("x");
    expect(style.italic("x")).toBe("x");
    expect(style.fg(39, "x")).toBe("x");
  });

  test("keeps empty strings empty when enabled", () => {
    const style = createTextStyle(true);
    expect(style.dim("")).toBe("");
    expect(style.fg(39, "")).toBe("");
  });
});

describe("escape builders", () => {
  test("builds cursor and erase sequences", () => {
    expect(cursorUp(0)).toBe("");
    expect(cursorUp(3)).toBe("\x1b[3A");
    expect(cursorToColumn(1)).toBe("\r");
    expect(cursorToColumn(9)).toBe("\x1b[9G");
    expect(eraseLineAll()).toBe("\x1b[2K");
    expect(eraseScreenBelow()).toBe("\x1b[J");
    expect(hideCursor()).toBe("\x1b[?25l");
    expect(showCursor()).toBe("\x1b[?25h");
    expect(enableBracketedPaste()).toBe("\x1b[?2004h");
    expect(disableBracketedPaste()).toBe("\x1b[?2004l");
  });
});
