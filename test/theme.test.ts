import { describe, expect, test } from "bun:test";
import { createTheme } from "../src/tui/theme";

describe("createTheme", () => {
  test("exposes the shared symbol set", () => {
    const theme = createTheme(true);
    expect(theme.symbols.prompt).toBe("❯");
    expect(theme.symbols.check).toBe("✓");
    expect(theme.symbols.cross).toBe("✗");
    expect(theme.symbols.spinner.length).toBeGreaterThan(4);
  });

  test("colors semantic helpers when enabled", () => {
    const theme = createTheme(true);
    expect(theme.brandText("x")).toBe(`\x1b[38;5;${theme.colors.brand}mx\x1b[0m`);
    expect(theme.errorText("x")).toBe(`\x1b[38;5;${theme.colors.error}mx\x1b[0m`);
  });

  test("keeps helpers plain when disabled", () => {
    const theme = createTheme(false);
    expect(theme.brandText("x")).toBe("x");
    expect(theme.style.dim("x")).toBe("x");
  });
});
