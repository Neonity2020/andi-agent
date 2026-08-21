import { afterEach, describe, expect, test } from "bun:test";
import type { Agent } from "../src/agent";
import { createWebServer } from "../src/web";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";

describe("local web server", () => {
  let close: (() => void) | undefined;

  afterEach(() => close?.());

  test("binds the API and serves the local UI", async () => {
    const workspace = await Workspace.create(process.cwd());
    const sessions = new SessionStore(workspace);
    await sessions.save("web-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world", toolCalls: [] },
    ]);
    const web = await createWebServer({
      workspace,
      sessions,
      port: 43217,
      model: {
        currentProvider: "test",
        currentModel: "test-model",
        availableProviders: () => ["test"],
      },
      agentFactory: { create: () => { throw new Error("not used"); } },
    });
    close = web.close;

    const health = await fetch(`http://127.0.0.1:${web.server.port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const probe = await fetch(`http://127.0.0.1:${web.server.port}/health`);
    expect(probe.status).toBe(200);
    expect((await probe.json()).ok).toBe(true);

    const opencodeProbe = await fetch(`http://127.0.0.1:${web.server.port}/api/opencode/health`);
    expect(opencodeProbe.status).toBe(200);
    expect((await opencodeProbe.json()).healthy).toBe(true);

    const path = await fetch(`http://127.0.0.1:${web.server.port}/api/path`);
    expect(path.status).toBe(200);
    expect((await path.json()).directory).toBe(workspace.root);

    const settings = await fetch(`http://127.0.0.1:${web.server.port}/api/config/settings`);
    const settingsBody = await settings.json();
    expect(settingsBody.projects[0].path).toBe(workspace.root);
    expect(settingsBody.activeProjectId).toBe(settingsBody.projects[0].id);
    expect(settingsBody.defaultModel).toBe("test/test-model");
    expect(settingsBody.messageStreamTransport).toBe("sse");

    const projects = await fetch(`http://127.0.0.1:${web.server.port}/api/project`);
    expect((await projects.json())[0].worktree).toBe(workspace.root);

    const opencodeSessions = await fetch(`http://127.0.0.1:${web.server.port}/api/session`);
    expect((await opencodeSessions.json())[0].id).toBe("web-session");

    const opencodeMessages = await fetch(`http://127.0.0.1:${web.server.port}/api/session/web-session/message`);
    const opencodeMessagesBody = await opencodeMessages.json();
    expect(opencodeMessagesBody[0].parts[0].text).toBe("hello");
    expect(opencodeMessagesBody[1].info.parentID).toBe(opencodeMessagesBody[0].info.id);

    const status = await fetch(`http://127.0.0.1:${web.server.port}/api/session/status`);
    expect(await status.json()).toEqual({});

    const page = await fetch(`http://127.0.0.1:${web.server.port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/andi-agent|OpenChamber/);

    const renamed = await fetch(`http://127.0.0.1:${web.server.port}/api/sessions/web-session`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-session" }),
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("renamed-session");

    const removed = await fetch(`http://127.0.0.1:${web.server.port}/api/sessions/renamed-session`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await sessions.load("renamed-session")).toEqual([]);
  });

  test("accepts OpenChamber prompt and permission replies", async () => {
    const workspace = await Workspace.create(process.cwd());
    const sessions = new SessionStore(workspace);
    let approved = false;
    const web = await createWebServer({
      workspace,
      sessions,
      port: 43218,
      model: {
        currentProvider: "test",
        currentModel: "test-model",
        availableProviders: () => ["test"],
      },
      agentFactory: {
        create({ approver, onEvent }) {
          return {
            runWithHistory: async (_task: string, _history: readonly unknown[], options: { signal?: AbortSignal }) => {
              approved = await approver(["bun", "test"], options.signal);
              onEvent({ type: "agent_completed", runId: "fake", turns: 1 });
              return {
                runId: "fake",
                output: "done",
                messages: [],
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelRequests: 0, modelDurationMs: 0 },
              };
            },
          } as unknown as Agent;
        },
      },
    });
    close = web.close;

    const prompt = await fetch(`http://127.0.0.1:${web.server.port}/api/session/openchamber/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID: "msg_ui", parts: [{ type: "text", text: "run tests" }] }),
    });
    expect(prompt.status).toBe(200);

    let pending: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 20 && pending.length === 0; attempt += 1) {
      pending = (await (await fetch(`http://127.0.0.1:${web.server.port}/api/permission`)).json()) as Array<Record<string, unknown>>;
      if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pending[0]?.id).toBeString();
    const runId = pending[0]!.id as string;
    const reply = await fetch(`http://127.0.0.1:${web.server.port}/api/permission/${runId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toBe(true);

    const events = await (await fetch(`http://127.0.0.1:${web.server.port}/api/runs/${runId}/events`)).text();
    expect(approved).toBe(true);
    expect(events).toContain("event: run_closed");
  });
});
