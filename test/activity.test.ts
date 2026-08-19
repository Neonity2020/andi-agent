import { describe, expect, test } from "bun:test";
import {
  ActivityState,
  formatDuration,
  parseThinkTags,
  renderCancelledTool,
  renderSealedTool,
  renderUserEcho,
  spinnerFrame,
} from "../src/tui/activity";
import { SPINNER_FRAMES, createTheme } from "../src/tui/theme";

const theme = createTheme(false);

describe("formatDuration", () => {
  test("formats milliseconds, seconds, and minutes", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(125_000)).toBe("2m05s");
  });
});

describe("spinnerFrame", () => {
  test("advances one frame per 90ms", () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(89)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(90)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrame(90 * SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
  });
});

describe("renderUserEcho", () => {
  test("prompts the first line and aligns continuation lines", () => {
    expect(renderUserEcho("hello world", 20, theme)).toEqual(["❯ hello world"]);
    expect(renderUserEcho("abc def", 6, theme)).toEqual(["❯ abc", "  def"]);
  });
});

describe("renderSealedTool", () => {
  test("marks success and failure with duration", () => {
    expect(renderSealedTool("read_file", true, 120, theme)).toBe("✓ read_file · 120ms");
    expect(renderSealedTool("edit_file", false, 1200, theme)).toBe("✗ edit_file · 1.2s");
  });

  test("renders cancelled tools dimly", () => {
    expect(renderCancelledTool("run_command", theme)).toBe("· run_command cancelled");
  });
});

describe("parseThinkTags", () => {
  test("separates MiniMax thinking from answer text, including an open tag", () => {
    expect(parseThinkTags("<think>先分析\n一下</think>答案")).toEqual({
      content: "答案",
      thinking: "先分析\n一下",
      thinkingOpen: false,
    });
    expect(parseThinkTags("<think>仍在思考")).toEqual({
      content: "",
      thinking: "仍在思考",
      thinkingOpen: true,
    });
  });
});

describe("ActivityState", () => {
  test("shows thinking, then a streaming preview, then idle", () => {
    const state = new ActivityState();
    expect(state.render(0, 40, theme)).toEqual([]);

    state.beginTurn(0);
    expect(state.render(100, 40, theme)).toEqual([`${SPINNER_FRAMES[1]} thinking · 100ms`]);

    state.appendDelta("hello streaming world");
    expect(state.phase).toBe("streaming");
    expect(state.render(200, 40, theme)).toEqual(["… hello streaming world"]);

    expect(state.takeStream()).toBe("hello streaming world");
    expect(state.takeStream()).toBe("");

    state.endTurn();
    expect(state.render(300, 40, theme)).toEqual([]);
  });

  test("tracks running tools until they end", () => {
    const state = new ActivityState();
    state.beginTurn(0);
    state.toolStarted("t1", "read_file", 0);
    state.toolStarted("t2", "search_code", 50);
    expect(state.render(1000, 40, theme)).toEqual([
      `${SPINNER_FRAMES[1]} read_file · 1.0s`,
      `${SPINNER_FRAMES[0]} search_code · 950ms`,
    ]);

    const ended = state.toolEnded("t1");
    expect(ended).toMatchObject({ id: "t1", name: "read_file" });
    expect(state.render(1000, 40, theme)).toEqual([`${SPINNER_FRAMES[0]} search_code · 950ms`]);
    expect(state.toolEnded("missing")).toBeUndefined();
  });

  test("keeps think-tag content collapsed while streaming", () => {
    const state = new ActivityState();
    state.beginTurn(0);
    state.appendDelta("<think>内部推理</think>最终答案");

    expect(state.takeStream()).toBe("最终答案");
    expect(state.takeThinking()).toEqual({ text: "内部推理", open: false });
  });
});
