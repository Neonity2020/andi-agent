import { describe, expect, test } from "bun:test";
import {
  createAgentToolRegistry,
  main,
  parseArguments,
  renderReadlinePrompt,
  resolveSessionId,
} from "../src/cli";
import { Workspace } from "../src/tools/workspace";

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
      plain: false,
      logEvents: false,
    });
  });

  test("parses the plain flag for the classic REPL", () => {
    expect(parseArguments(["--repl", "--plain"])).toMatchObject({ repl: true, plain: true });
  });

  test("rejects an invalid approval mode", () => {
    expect(() => parseArguments(["--approval", "always", "task"])).toThrow("必须是 'ask' 或 'never'");
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

describe("main", () => {
  test("defaults to REPL mode when invoked without arguments", async () => {
    await expect(main([])).rejects.toThrow("--repl requires an interactive TTY");
  });
});

describe("resolveSessionId", () => {
  test("uses a persistent default session for REPL mode", () => {
    expect(resolveSessionId({ repl: true, session: undefined })).toBe("default");
  });

  test("preserves explicit sessions and does not default one-shot runs", () => {
    expect(resolveSessionId({ repl: true, session: "feature-auth" })).toBe("feature-auth");
    expect(resolveSessionId({ repl: false, session: undefined })).toBeUndefined();
  });
});

describe("createAgentToolRegistry", () => {
  test("registers web_search only when Exa is configured", async () => {
    const workspace = await Workspace.create(process.cwd());
    const config = {
      apiKey: "agnes",
      model: "fake",
      baseUrl: "https://example.invalid/v1",
      maxTurns: 3,
      maxContextChars: 10_000,
    };

    expect(createAgentToolRegistry(workspace, config).definitions().map((tool) => tool.name)).not.toContain(
      "web_search",
    );
    expect(createAgentToolRegistry(workspace, config).definitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["memory_search", "memory_read", "memory_remember", "memory_archive"]),
    );
    expect(
      createAgentToolRegistry(workspace, {
        ...config,
        exa: { apiKey: "exa", baseUrl: "https://api.exa.test" },
      })
        .definitions()
        .map((tool) => tool.name),
    ).toContain("web_search");
  });
});
