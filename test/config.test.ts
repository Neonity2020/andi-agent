import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("uses Agnes 2.5 Flash defaults", () => {
    expect(loadConfig({ AGNES_API_KEY: "test-key" })).toEqual({
      provider: "agnes",
      apiKey: "test-key",
      model: "agnes-2.5-flash",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      maxTurns: 12,
      maxContextChars: 120000,
      providers: {
        agnes: {
          apiKey: "test-key",
          model: "agnes-2.5-flash",
          baseUrl: "https://apihub.agnes-ai.com/v1",
        },
      },
    });
  });

  test("loads the domestic MiniMax provider defaults", () => {
    expect(loadConfig({ MINIMAX_API_KEY: "minimax-key" })).toEqual({
      provider: "minimax",
      apiKey: "minimax-key",
      model: "MiniMax-M2.7",
      baseUrl: "https://api.minimaxi.com/v1",
      maxTurns: 12,
      maxContextChars: 120000,
      providers: {
        minimax: {
          apiKey: "minimax-key",
          model: "MiniMax-M2.7",
          baseUrl: "https://api.minimaxi.com/v1",
        },
      },
    });
  });

  test("accepts the generic API key variable for compatibility", () => {
    expect(loadConfig({ AGENT_API_KEY: "generic-key" }).apiKey).toBe("generic-key");
  });

  test("loads optional Exa search configuration without making it required", () => {
    expect(loadConfig({ AGNES_API_KEY: "agnes" }).exa).toBeUndefined();
    expect(
      loadConfig({
        AGNES_API_KEY: "agnes",
        EXA_API_KEY: " exa-key ",
        EXA_BASE_URL: "https://exa.test/",
      }).exa,
    ).toEqual({ apiKey: "exa-key", baseUrl: "https://exa.test/" });
  });
});
