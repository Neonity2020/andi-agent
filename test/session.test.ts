import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "../src/model/types";
import { SessionStore, validateSessionId } from "../src/session";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<{ store: SessionStore; workspace: Workspace }> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-session-"));
  temporaryDirectories.push(directory);
  const workspace = await Workspace.create(directory);
  return { store: new SessionStore(workspace), workspace };
}

describe("SessionStore", () => {
  test("atomically saves and loads messages", async () => {
    const { store, workspace } = await setup();
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", toolCalls: [] },
    ];

    await store.save("demo-1", messages);

    expect(await store.load("demo-1")).toEqual(messages);
    expect(await workspace.list()).toEqual([]);
    expect(() => workspace.assertToolPath(".andi-agent/sessions/demo-1.json")).toThrow("reserved");
  });

  test("returns an empty history for a new session", async () => {
    const { store } = await setup();
    expect(await store.load("new-session")).toEqual([]);
  });

  test("rejects unsafe session IDs", () => {
    expect(() => validateSessionId("../outside")).toThrow("Session ID");
    expect(() => validateSessionId("spaces are unsafe")).toThrow("Session ID");
  });
});
