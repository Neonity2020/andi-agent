import { describe, expect, test } from "bun:test";
import { isCommandAllowed, runCommand } from "../src/tools/command";

describe("command policy", () => {
  test("allows verification commands and routes Git through dedicated tools", () => {
    expect(isCommandAllowed("bun", ["test"])).toBeTrue();
    expect(isCommandAllowed("bun", ["run", "typecheck"])).toBeTrue();
    expect(isCommandAllowed("tsc", ["--noEmit"])).toBeTrue();
    expect(isCommandAllowed("git", ["diff"])).toBeFalse();
  });

  test("rejects shells, installs, arbitrary scripts, and Git writes", () => {
    expect(isCommandAllowed("sh", ["-c", "echo unsafe"])).toBeFalse();
    expect(isCommandAllowed("bun", ["install"])).toBeFalse();
    expect(isCommandAllowed("npm", ["run", "publish"])).toBeFalse();
    expect(isCommandAllowed("git", ["commit"])).toBeFalse();
  });
});

describe("runCommand", () => {
  test("runs an approved command and captures its output", async () => {
    const result = await runCommand(process.cwd(), "npm", ["run", "typecheck"], 10_000);

    expect(result.exitCode).toBe(0);
    expect(result.command).toEqual(["npm", "run", "typecheck"]);
    expect(result.stdout).toContain("tsc --noEmit");
    expect(result.timedOut).toBeFalse();
  });

  test("rejects a command before spawning it", () => {
    expect(runCommand(process.cwd(), "git", ["reset"], 5_000)).rejects.toThrow("requires approval");
  });

  test("runs a non-policy command only after approval", async () => {
    const approved: string[][] = [];
    const result = await runCommand(process.cwd(), "node", ["--version"], 5_000, 64 * 1024, async (command) => {
      approved.push([...command]);
      return true;
    });

    expect(approved).toEqual([["node", "--version"]]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("v");
  });

  test("does not run a rejected command", () => {
    expect(
      runCommand(process.cwd(), "node", ["--version"], 5_000, 64 * 1024, async () => false),
    ).rejects.toThrow("rejected by the user");
  });
});
