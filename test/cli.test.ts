import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/cli";

describe("parseArguments", () => {
  test("parses session and approval options", () => {
    expect(parseArguments(["--cwd", "/tmp", "--session", "feature-1", "--approval", "never", "do", "work"])).toEqual({
      cwd: "/tmp",
      session: "feature-1",
      approval: "never",
      task: "do work",
    });
  });

  test("rejects an invalid approval mode", () => {
    expect(() => parseArguments(["--approval", "always", "task"])).toThrow("ask' or 'never");
  });
});
