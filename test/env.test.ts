import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInstallEnv, parseEnvFile } from "../src/runtime/env";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parseEnvFile", () => {
  test("parses assignments, trims whitespace, and strips quotes", () => {
    expect(
      parseEnvFile([
        "# comment",
        "",
        "AGNES_API_KEY=secret",
        "  AGENT_MODEL = agnes-2.5-flash  ",
        'AGENT_BASE_URL="https://example.invalid/v1"',
        "EXA_BASE_URL='https://exa.example'",
      ].join("\n")),
    ).toEqual({
      AGNES_API_KEY: "secret",
      AGENT_MODEL: "agnes-2.5-flash",
      AGENT_BASE_URL: "https://example.invalid/v1",
      EXA_BASE_URL: "https://exa.example",
    });
  });

  test("ignores lines without a usable assignment", () => {
    expect(parseEnvFile("MALFORMED\n=VALUE\nA=B")).toEqual({ A: "B" });
  });
});

describe("applyInstallEnv", () => {
  test("fills missing variables from the install .env without overriding set ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "andi-agent-env-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, ".env"),
      "AGNES_API_KEY=install-key\nAGENT_MODEL=install-model\nAGENT_MAX_TURNS=20\n",
    );

    const env: Record<string, string | undefined> = {
      AGNES_API_KEY: "workspace-key",
      AGENT_MAX_TURNS: "",
    };
    await applyInstallEnv(env, directory);

    expect(env.AGNES_API_KEY).toBe("workspace-key");
    expect(env.AGENT_MODEL).toBe("install-model");
    expect(env.AGENT_MAX_TURNS).toBe("20");
  });

  test("does nothing when the install .env is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "andi-agent-env-"));
    temporaryDirectories.push(directory);

    const env: Record<string, string | undefined> = { AGNES_API_KEY: "kept" };
    await applyInstallEnv(env, directory);

    expect(env).toEqual({ AGNES_API_KEY: "kept" });
  });
});
