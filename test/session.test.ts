import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "../src/model/types";
import { repairIncompleteToolCalls, SessionStore, validateSessionId } from "../src/session";
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

  test("migrates v1 sessions to v2", async () => {
    const { store, workspace } = await setup();
    await workspace.write(
      ".andi-agent/sessions/legacy.json",
      JSON.stringify({
        version: 1,
        id: "legacy",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ role: "user", content: "old" }],
      }),
    );

    const snapshot = await store.loadSnapshot("legacy");
    const persisted = JSON.parse(await workspace.read(".andi-agent/sessions/legacy.json")) as { version: number };

    expect(snapshot.messages).toEqual([{ role: "user", content: "old" }]);
    expect(snapshot.usage.totalTokens).toBe(0);
    expect(persisted.version).toBe(2);
  });

  test("repairs interrupted tool calls and persists an idle session", async () => {
    const { store } = await setup();
    await store.saveSnapshot("interrupted", {
      state: "running",
      activeRunId: "run-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
        },
      ],
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, modelRequests: 1, modelDurationMs: 10 },
    });

    const snapshot = await store.loadSnapshot("interrupted");

    expect(snapshot.state).toBe("idle");
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.messages.some((message) => message.role === "tool" && message.toolCallId === "call-1")).toBeTrue();
    expect(snapshot.messages.at(-1)?.role).toBe("system");
  });

  test("does not duplicate existing tool results during repair", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call-1", name: "read_file", content: "ok" },
    ];

    expect(repairIncompleteToolCalls(messages)).toEqual({ messages, repairedToolResults: 0 });
  });

  test("serializes concurrent snapshot writes in call order", async () => {
    const { store } = await setup();
    const base = {
      state: "idle" as const,
      activeRunId: undefined,
      updatedAt: "2026-01-01T00:00:00.000Z",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelRequests: 0, modelDurationMs: 0 },
    };
    await Promise.all([
      store.saveSnapshot("ordered", { ...base, messages: [{ role: "user", content: "first" }] }),
      store.saveSnapshot("ordered", { ...base, messages: [{ role: "user", content: "second" }] }),
    ]);

    expect((await store.loadSnapshot("ordered")).messages).toEqual([{ role: "user", content: "second" }]);
  });

  test("renames the session ID and persistence file", async () => {
    const { store, workspace } = await setup();
    await store.save("before", [{ role: "user", content: "keep me" }]);

    await store.rename("before", "after");

    expect(await store.load("after")).toEqual([{ role: "user", content: "keep me" }]);
    await expect(workspace.read(".andi-agent/sessions/before.json")).rejects.toThrow();
    expect(JSON.parse(await workspace.read(".andi-agent/sessions/after.json"))).toMatchObject({ id: "after" });
  });

  test("deletes the persistence file and reports missing sessions", async () => {
    const { store, workspace } = await setup();
    await store.save("to-delete", []);

    expect(await store.delete("to-delete")).toBeTrue();
    expect(await store.delete("to-delete")).toBeFalse();
    await expect(workspace.read(".andi-agent/sessions/to-delete.json")).rejects.toThrow();
  });
});
