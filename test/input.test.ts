import { describe, expect, test } from "bun:test";
import { InputDecoder, LineEditor, type KeyEvent } from "../src/tui/input";

function decode(...chunks: Uint8Array[]): KeyEvent[] {
  const decoder = new InputDecoder();
  return chunks.flatMap((chunk) => decoder.push(chunk));
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("InputDecoder", () => {
  test("flushes a lone escape for modal cancellation", () => {
    const input = new InputDecoder();
    expect(input.push(new Uint8Array([0x1b]))).toEqual([]);
    expect(input.flushEscape()).toEqual({ key: "escape" });
  });

  test("decodes plain text runs into a single event", () => {
    expect(decode(bytes("hello"))).toEqual([{ key: "text", text: "hello" }]);
  });

  test("decodes multibyte UTF-8, including across chunk splits", () => {
    expect(decode(bytes("你好"))).toEqual([{ key: "text", text: "你好" }]);
    expect(decode(bytes("你"), bytes("好"))).toEqual([
      { key: "text", text: "你" },
      { key: "text", text: "好" },
    ]);
  });

  test("maps control bytes to semantic keys", () => {
    expect(decode(bytes("\r"))).toEqual([{ key: "enter" }]);
    expect(decode(bytes("\n"))).toEqual([{ key: "newline" }]);
    expect(decode(bytes("\t"))).toEqual([{ key: "tab" }]);
    expect(decode(bytes("\x7f"))).toEqual([{ key: "backspace" }]);
    expect(decode(bytes("\x03"))).toEqual([{ key: "interrupt" }]);
    expect(decode(bytes("\x04"))).toEqual([{ key: "eof" }]);
    expect(decode(bytes("\x15"))).toEqual([{ key: "killToStart" }]);
    expect(decode(bytes("\x17"))).toEqual([{ key: "killWord" }]);
  });

  test("decodes CSI arrow and editing sequences, including split chunks", () => {
    expect(decode(bytes("\x1b[A\x1b[B\x1b[C\x1b[D"))).toEqual([
      { key: "up" },
      { key: "down" },
      { key: "right" },
      { key: "left" },
    ]);
    expect(decode(bytes("\x1b"), bytes("[A"))).toEqual([{ key: "up" }]);
    expect(decode(bytes("\x1b[H\x1b[F"))).toEqual([{ key: "home" }, { key: "end" }]);
    expect(decode(bytes("\x1b[3~\x1b[5~\x1b[6~"))).toEqual([
      { key: "delete" },
      { key: "pageup" },
      { key: "pagedown" },
    ]);
  });

  test("decodes SS3 sequences and modified arrows", () => {
    expect(decode(bytes("\x1bOA"))).toEqual([{ key: "up" }]);
    expect(decode(bytes("\x1b[1;5C\x1b[1;3D"))).toEqual([{ key: "wordRight" }, { key: "wordLeft" }]);
  });

  test("decodes alt+b / alt+f / alt+backspace", () => {
    expect(decode(bytes("\x1bb"))).toEqual([{ key: "wordLeft" }]);
    expect(decode(bytes("\x1bf"))).toEqual([{ key: "wordRight" }]);
    expect(decode(bytes("\x1b\x7f"))).toEqual([{ key: "killWord" }]);
  });

  test("holds a lone escape until the next byte resolves it", () => {
    expect(decode(bytes("\x1b"))).toEqual([]);
    expect(decode(bytes("\x1b"), bytes("[C"))).toEqual([{ key: "right" }]);
  });

  test("collects bracketed paste content, including across chunks", () => {
    const start = "\x1b[200~";
    const end = "\x1b[201~";
    expect(decode(bytes(`${start}pasted text${end}`))).toEqual([{ key: "paste", text: "pasted text" }]);
    expect(decode(bytes(`${start}line one\nline two`), bytes(`${end}x`))).toEqual([
      { key: "paste", text: "line one\nline two" },
      { key: "text", text: "x" },
    ]);
  });

  test("skips OSC sequences terminated by BEL or ST", () => {
    expect(decode(bytes("\x1b]0;title\x07k"))).toEqual([{ key: "text", text: "k" }]);
    expect(decode(bytes("\x1b]0;title\x1b\\k"))).toEqual([{ key: "text", text: "k" }]);
  });
});

describe("LineEditor", () => {
  test("inserts text and moves the cursor by cluster", () => {
    const editor = new LineEditor();
    expect(editor.handleKey({ key: "text", text: "abc" })).toEqual({ type: "changed" });
    expect(editor.handleKey({ key: "left" })).toEqual({ type: "changed" });
    expect(editor.handleKey({ key: "text", text: "X" })).toEqual({ type: "changed" });
    expect(editor.getText()).toBe("abXc");
    expect(editor.getCursorCol()).toBe(3);
  });

  test("deletes clusters, keeping emoji intact", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "text", text: "a👍b" });
    expect(editor.getRowClusters(0)).toEqual(["a", "👍", "b"]);
    editor.handleKey({ key: "left" });
    editor.handleKey({ key: "backspace" });
    expect(editor.getText()).toBe("ab");
    editor.handleKey({ key: "home" });
    editor.handleKey({ key: "delete" });
    expect(editor.getText()).toBe("b");
  });

  test("moves by words and kills words and line regions", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "text", text: "hello world foo" });
    editor.handleKey({ key: "wordLeft" });
    expect(editor.getCursorCol()).toBe(12);
    editor.handleKey({ key: "wordRight" });
    expect(editor.getCursorCol()).toBe(15);
    editor.handleKey({ key: "killWord" });
    expect(editor.getText()).toBe("hello world ");
    editor.handleKey({ key: "home" });
    editor.handleKey({ key: "wordRight" });
    expect(editor.getCursorCol()).toBe(6);
    editor.handleKey({ key: "killToStart" });
    expect(editor.getText()).toBe("world ");
    editor.handleKey({ key: "right" });
    editor.handleKey({ key: "right" });
    editor.handleKey({ key: "right" });
    editor.handleKey({ key: "killLine" });
    expect(editor.getText()).toBe("wor");
  });

  test("keeps pasted newlines as editor rows", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "paste", text: "line one\nline two\r\nend" });
    expect(editor.getText()).toBe("line one\nline two\nend");
    expect(editor.getLineCount()).toBe(3);
  });

  test("submits, resets, and records trimmed history without duplicates", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "text", text: "  first  " });
    expect(editor.handleKey({ key: "enter" })).toEqual({ type: "submitted", line: "  first  " });
    expect(editor.getText()).toBe("");
    editor.handleKey({ key: "text", text: "first" });
    expect(editor.handleKey({ key: "enter" })).toEqual({ type: "submitted", line: "first" });
    editor.handleKey({ key: "up" });
    expect(editor.getText()).toBe("first");
  });

  test("navigates history and restores the draft", () => {
    const editor = new LineEditor(["one", "two"]);
    editor.handleKey({ key: "text", text: "draf" });
    editor.handleKey({ key: "up" });
    expect(editor.getText()).toBe("two");
    editor.handleKey({ key: "up" });
    expect(editor.getText()).toBe("one");
    editor.handleKey({ key: "up" });
    expect(editor.getText()).toBe("one");
    editor.handleKey({ key: "down" });
    expect(editor.getText()).toBe("two");
    editor.handleKey({ key: "down" });
    expect(editor.getText()).toBe("draf");
  });

  test("splits lines with newline and merges them with backspace and delete", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "text", text: "ab" });
    editor.handleKey({ key: "left" });
    expect(editor.handleKey({ key: "newline" })).toEqual({ type: "changed" });
    expect(editor.getText()).toBe("a\nb");
    expect(editor.getCursorRow()).toBe(1);
    expect(editor.getCursorCol()).toBe(0);
    editor.handleKey({ key: "backspace" });
    expect(editor.getText()).toBe("ab");
    expect(editor.getCursorRow()).toBe(0);
    expect(editor.getCursorCol()).toBe(1);
    editor.handleKey({ key: "end" });
    editor.handleKey({ key: "newline" });
    expect(editor.getText()).toBe("ab\n");
    editor.handleKey({ key: "backspace" });
    expect(editor.getText()).toBe("ab");
  });

  test("moves the caret across rows and falls through to history at edges", () => {
    const editor = new LineEditor(["old"]);
    editor.handleKey({ key: "paste", text: "one\ntwo" });
    expect(editor.getCursorRow()).toBe(1);
    // Down at the last row has no newer history entry, so the buffer stays.
    editor.handleKey({ key: "down" });
    expect(editor.getText()).toBe("one\ntwo");
    editor.handleKey({ key: "up" });
    expect(editor.getCursorRow()).toBe(0);
    expect(editor.getCursorCol()).toBe(3);
    // Up at the first row loads the previous history entry.
    editor.handleKey({ key: "up" });
    expect(editor.getText()).toBe("old");
    expect(editor.getCursorRow()).toBe(0);
    // Down past the last entry restores the multi-line draft.
    editor.handleKey({ key: "down" });
    expect(editor.getText()).toBe("one\ntwo");
    expect(editor.getCursorRow()).toBe(0);
  });

  test("submits multi-line drafts and restores them from history", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "paste", text: "const a = 1;\nconst b = 2;" });
    expect(editor.handleKey({ key: "enter" })).toEqual({
      type: "submitted",
      line: "const a = 1;\nconst b = 2;",
    });
    editor.handleKey({ key: "up" });
    expect(editor.getText()).toBe("const a = 1;\nconst b = 2;");
    expect(editor.getCursorRow()).toBe(0);
  });

  test("setText replaces the buffer for completion inserts", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "text", text: "/mo" });
    expect(editor.setText("/models ")).toEqual({ type: "changed" });
    expect(editor.getText()).toBe("/models ");
    expect(editor.getCursorRow()).toBe(0);
    expect(editor.getCursorCol()).toBe(8);
  });

  test("passes interrupt and eof through without touching the buffer", () => {
    const editor = new LineEditor();
    editor.handleKey({ key: "text", text: "x" });
    expect(editor.handleKey({ key: "interrupt" })).toEqual({ type: "interrupt" });
    expect(editor.getText()).toBe("x");
    expect(editor.handleKey({ key: "eof" })).toEqual({ type: "none" });
    editor.handleKey({ key: "killToStart" });
    expect(editor.handleKey({ key: "eof" })).toEqual({ type: "eof" });
  });

  test("ignores keys with no effect instead of reporting changes", () => {
    const editor = new LineEditor();
    expect(editor.handleKey({ key: "left" })).toEqual({ type: "none" });
    expect(editor.handleKey({ key: "backspace" })).toEqual({ type: "none" });
    expect(editor.handleKey({ key: "home" })).toEqual({ type: "none" });
  });
});
