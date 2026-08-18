import { describe, expect, test } from "bun:test";
import { InlineScreen, type ScreenSink } from "../src/tui/screen";

function createHarness(columns: number): { screen: InlineScreen; output: string[] } {
  const output: string[] = [];
  const sink: ScreenSink = { write: (data) => output.push(data) };
  const screen = new InlineScreen({ sink, columns: () => columns });
  return { screen, output };
}

describe("InlineScreen", () => {
  test("first render writes lines without lifting", () => {
    const { screen, output } = createHarness(40);
    screen.render(["alpha", "beta"]);
    expect(output.join("")).toBe("\x1b[2Kalpha\n\x1b[2Kbeta\n\x1b[J");
  });

  test("repaint lifts over the previous region and clears residue when shrinking", () => {
    const { screen, output } = createHarness(40);
    screen.render(["a", "b"]);
    output.length = 0;
    screen.render(["x", "y", "z"]);
    expect(output.join("")).toBe("\x1b[2A\r\x1b[2Kx\n\x1b[2Ky\n\x1b[2Kz\n\x1b[J");
    output.length = 0;
    screen.render(["only"]);
    expect(output.join("")).toBe("\x1b[3A\r\x1b[2Konly\n\x1b[J");
    expect(screen.paintedLines).toBe(1);
  });

  test("rendering an empty region erases the previous one", () => {
    const { screen, output } = createHarness(40);
    screen.render(["a"]);
    output.length = 0;
    screen.render([]);
    expect(output.join("")).toBe("\x1b[1A\r\x1b[J");
    expect(screen.paintedLines).toBe(0);
  });

  test("hard-wraps unstyled overlong lines to the terminal width", () => {
    const { screen, output } = createHarness(5);
    screen.render(["abcdefgh"]);
    expect(output.join("")).toBe("\x1b[2Kabcde\n\x1b[2Kfgh\n\x1b[J");
    expect(screen.paintedLines).toBe(2);
  });

  test("keeps styled lines untouched", () => {
    const { screen, output } = createHarness(5);
    screen.render(["\x1b[1mabcdefgh\x1b[0m"]);
    expect(output.join("")).toBe("\x1b[2K\x1b[1mabcdefgh\x1b[0m\n\x1b[J");
  });

  test("repaints from a positioned cursor without lifting into scrollback", () => {
    const { screen, output } = createHarness(40);
    screen.print(["sealed"]);
    screen.render(["a", "b"]);
    screen.positionCursor(2, 3);
    output.length = 0;
    screen.render(["x", "y"]);
    const data = output.join("");
    // Cursor already sits on the region's top row: lift is just a column
    // reset, never a cursorUp that would eat the sealed line above.
    expect(data.startsWith("\r\x1b[2Kx")).toBeTrue();
    expect(data).not.toContain("\x1b[2A");
  });

  test("disposes from a positioned cursor with the right lift", () => {
    const { screen, output } = createHarness(40);
    screen.render(["a", "b", "c"]);
    screen.positionCursor(2, 4);
    output.length = 0;
    screen.dispose();
    expect(output.join("")).toBe("\x1b[1A\r\x1b[J");
  });

  test("print seals lines into scrollback and repaints the region", () => {
    const { screen, output } = createHarness(40);
    screen.render(["a", "b"]);
    output.length = 0;
    screen.print(["sealed"]);
    expect(output.join("")).toBe("\x1b[2A\r\x1b[2Ksealed\n\x1b[2Ka\n\x1b[2Kb\n\x1b[J");
    expect(screen.paintedLines).toBe(2);
  });

  test("print with no lines writes nothing", () => {
    const { screen, output } = createHarness(40);
    screen.render(["a"]);
    output.length = 0;
    screen.print([]);
    expect(output).toEqual([]);
  });

  test("dispose erases the region and resets internal state", () => {
    const { screen, output } = createHarness(40);
    screen.render(["a", "b", "c"]);
    output.length = 0;
    screen.dispose();
    expect(output.join("")).toBe("\x1b[3A\r\x1b[J");
    expect(screen.paintedLines).toBe(0);
    output.length = 0;
    screen.render(["fresh"]);
    expect(output.join("")).toBe("\x1b[2Kfresh\n\x1b[J");
  });
});
