import { describe, expect, test } from "bun:test";
import { parseArguments, renderReadlinePrompt } from "../src/cli";

describe("renderReadlinePrompt", () => {
  test("registers the prompt with readline before rendering it", () => {
    const calls: string[] = [];

    renderReadlinePrompt(
      {
        setPrompt(prompt) {
          calls.push(`set:${prompt}`);
        },
        prompt() {
          calls.push("render");
        },
      },
      "you> ",
    );

    expect(calls).toEqual(["set:you> ", "render"]);
  });
});

describe("parseArguments", () => {
  test("parses session and approval options", () => {
    expect(parseArguments(["--cwd", "/tmp", "--session", "feature-1", "--approval", "never", "do", "work"])).toEqual({
      cwd: "/tmp",
      session: "feature-1",
      approval: "never",
      task: "do work",
      repl: false,
      logEvents: false,
    });
  });

  test("rejects an invalid approval mode", () => {
    expect(() => parseArguments(["--approval", "always", "task"])).toThrow("ask' or 'never");
  });

  test("allows REPL mode without an initial task", () => {
    expect(parseArguments(["--repl", "--session", "dev"])).toMatchObject({
      repl: true,
      session: "dev",
      task: undefined,
      logEvents: false,
    });
  });

  test("parses event logging mode", () => {
    expect(parseArguments(["--log-events", "task"]).logEvents).toBeTrue();
  });
});
