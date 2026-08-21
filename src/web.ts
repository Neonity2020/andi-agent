import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Agent, AgentEvent, AgentRunResult } from "./agent";
import type { CommandApprover } from "./tools/command";
import type { Message, RunUsage } from "./model/types";
import { addRunUsage, emptyRunUsage } from "./usage";
import { SessionStore, validateSessionId } from "./session";
import type { Workspace } from "./tools/workspace";

export interface WebAgentFactory {
  create(options: {
    runId: string;
    approver: CommandApprover;
    onEvent: (event: AgentEvent) => void | Promise<void>;
  }): Agent;
}

interface WebRun {
  id: string;
  sessionId: string;
  controller: AbortController;
  events: string[];
  listeners: Set<(chunk: string) => void>;
  approval: WebApproval | undefined;
  done: boolean;
  directory: string;
  userMessageId: string;
  assistantMessageId: string;
  assistantPartId: string;
  assistantText: string;
}

interface WebApproval {
  command: string[];
  resolve: (approved: boolean) => void;
}

interface OpenCodeModel {
  providerID: string;
  modelID: string;
}

const openChamberProjectId = (projectPath: string): string => {
  const bytes = new TextEncoder().encode(projectPath.replace(/\\/g, "/").replace(/\/+$/, ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `path_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
};

export interface WebServerOptions {
  workspace: Workspace;
  sessions: SessionStore;
  agentFactory: WebAgentFactory;
  model: { currentProvider: string; currentModel: string; availableProviders(): readonly string[] };
  port?: number | undefined;
}

export interface WebServer {
  server: Bun.Server<undefined>;
  close(): void;
}

export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  const runs = new Map<string, WebRun>();
  const activeBySession = new Set<string>();
  const globalEvents: string[] = [];
  const globalListeners = new Set<(chunk: string) => void>();
  const openChamberDist = join(import.meta.dir, "web/packages/web/dist");
  const openChamberAvailable = await Bun.file(join(openChamberDist, "index.html")).exists();
  const bundle = openChamberAvailable ? "" : await buildWebBundle(options.workspace.root);
  const codeModel: OpenCodeModel = {
    providerID: options.model.currentProvider,
    modelID: options.model.currentModel,
  };
  const projectPath = options.workspace.root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const projectId = openChamberProjectId(projectPath);
  const projectTime = Date.now();
  const openChamberSettings = {
    homeDirectory: projectPath,
    lastDirectory: projectPath,
    projects: [{ id: projectId, path: projectPath, label: basename(projectPath) || projectPath, addedAt: projectTime, lastOpenedAt: projectTime }],
    activeProjectId: projectId,
    defaultModel: `${codeModel.providerID}/${codeModel.modelID}`,
    defaultAgent: "build",
    messageStreamTransport: "sse",
  };

  const send = (run: WebRun, event: string, data: unknown): void => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    run.events.push(chunk);
    for (const listener of run.listeners) listener(chunk);
  };

  const sendGlobal = (type: string, properties: Record<string, unknown>): void => {
    const eventId = crypto.randomUUID();
    const chunk = `id: ${eventId}\ndata: ${JSON.stringify({ type, properties })}\n\n`;
    globalEvents.push(chunk);
    if (globalEvents.length > 1_000) globalEvents.shift();
    for (const listener of globalListeners) listener(chunk);
  };

  const startRun = async (run: WebRun, task: string): Promise<void> => {
    try {
      const snapshot = await options.sessions.loadSnapshot(run.sessionId);
      const baseUsage = snapshot.usage ?? emptyRunUsage();
      const agent = options.agentFactory.create({
        runId: run.id,
        approver: async (command, signal) => {
          if (signal?.aborted || run.controller.signal.aborted) return false;
          return new Promise<boolean>((resolve) => {
            run.approval = { command: [...command], resolve };
            send(run, "approval_required", { runId: run.id, command: [...command] });
            sendGlobal("permission.asked", {
              id: run.id,
              directory: run.directory,
              sessionID: run.sessionId,
              permission: "run_command",
              patterns: [command.join(" ")],
              metadata: { command: command.join(" "), cwd: run.directory },
              always: [],
            });
            const abort = (): void => {
              if (run.approval?.resolve === resolve) {
                run.approval = undefined;
                resolve(false);
              }
            };
            signal?.addEventListener("abort", abort, { once: true });
            run.controller.signal.addEventListener("abort", abort, { once: true });
          });
        },
        onEvent: (event) => {
          send(run, event.type, event);
          emitOpenCodeAgentEvent(run, event, sendGlobal, codeModel);
        },
      });

      sendGlobal("session.status", { sessionID: run.sessionId, directory: run.directory, status: { type: "busy" } });
      sendGlobal("message.updated", {
        directory: run.directory,
        info: openCodeMessageInfo(run.userMessageId, run.sessionId, "user", run.directory, codeModel),
      });
      sendGlobal("message.part.updated", {
        directory: run.directory,
        part: { id: `${run.userMessageId}-part`, sessionID: run.sessionId, messageID: run.userMessageId, type: "text", text: task },
      });
      sendGlobal("message.updated", {
        directory: run.directory,
        info: openCodeMessageInfo(run.assistantMessageId, run.sessionId, "assistant", run.directory, codeModel, run.userMessageId),
      });
      sendGlobal("message.part.updated", {
        directory: run.directory,
        part: { id: run.assistantPartId, sessionID: run.sessionId, messageID: run.assistantMessageId, type: "text", text: "" },
      });
      send(run, "run_started", { runId: run.id, sessionId: run.sessionId });
      const result = await agent.runWithHistory(task, snapshot.messages, {
        signal: run.controller.signal,
        onCheckpoint: (checkpoint) =>
          options.sessions.saveCheckpoint(run.sessionId, checkpoint, addRunUsage(baseUsage, checkpoint.usage)),
      });
      send(run, "run_completed", serializeResult(result));
    } catch (error) {
      if (!run.controller.signal.aborted) {
        send(run, "run_failed", { runId: run.id, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      run.done = true;
      activeBySession.delete(run.sessionId);
      if (run.approval) {
        run.approval.resolve(false);
        run.approval = undefined;
      }
      send(run, "run_closed", { runId: run.id });
    }
  };

  const launchRun = (sessionId: string, task: string, userMessageId?: string): WebRun | undefined => {
    validateSessionId(sessionId);
    if (task.trim().length === 0 || activeBySession.has(sessionId)) return undefined;
    const run: WebRun = {
      id: crypto.randomUUID(),
      sessionId,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      approval: undefined,
      done: false,
      directory: options.workspace.root,
      userMessageId: userMessageId ?? `msg_${crypto.randomUUID()}`,
      assistantMessageId: `msg_${crypto.randomUUID()}`,
      assistantPartId: `prt_${crypto.randomUUID()}`,
      assistantText: "",
    };
    runs.set(run.id, run);
    activeBySession.add(sessionId);
    void startRun(run, task.trim());
    return run;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 4317,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, openCodeRunning: true, isOpenCodeReady: true });
      }
      if (request.method === "GET" && (url.pathname === "/opencode/health" || url.pathname === "/api/opencode/health")) {
        return json({ healthy: true, ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        return new Response(bundle, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      }
      if (request.method === "GET" && url.pathname === "/vendor/katex.min.css") {
        return new Response(Bun.file(join(import.meta.dir, "../node_modules/katex/dist/katex.min.css")));
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        return json({
          workspace: basename(options.workspace.root),
          cwd: options.workspace.root,
          provider: options.model.currentProvider,
          model: options.model.currentModel,
          providers: options.model.availableProviders(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/path") {
        return json({ home: options.workspace.root, state: options.workspace.root, worktree: options.workspace.root, directory: options.workspace.root, config: options.workspace.root });
      }
      if (request.method === "GET" && url.pathname === "/api/project") {
        return json([openCodeProject(options.workspace.root)]);
      }
      if (request.method === "GET" && url.pathname === "/api/project/current") {
        return json(openCodeProject(options.workspace.root));
      }
      if (request.method === "GET" && (url.pathname === "/api/config" || url.pathname === "/api/global/config")) {
        return json({ model: `${options.model.currentProvider}/${options.model.currentModel}`, default_agent: "build" });
      }
      if (request.method === "GET" && url.pathname === "/api/config/providers") {
        const providerID = options.model.currentProvider || "agnes";
        const modelID = options.model.currentModel || "agnes-2.5-flash";
        const provider = {
            id: providerID,
            name: providerID,
            source: "config",
            env: [],
            options: {},
            models: {
              [modelID]: {
                id: modelID,
                name: modelID,
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
                limit: { context: 120_000, output: 16_000 },
              },
            },
          };
        return json({
          providers: [provider],
          default: { [providerID]: modelID },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/provider") {
        const providerID = options.model.currentProvider || "agnes";
        const modelID = options.model.currentModel || "agnes-2.5-flash";
        return json({
          all: [{ id: providerID, name: providerID, source: "config", env: [], options: {}, models: {
            [modelID]: { id: modelID, name: modelID, reasoning: true, tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 120_000, output: 16_000 } },
          } }],
          default: { [providerID]: modelID },
          connected: [providerID],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/agent") return json([]);
      if (request.method === "GET" && url.pathname === "/api/command") return json([]);
      if (request.method === "GET" && url.pathname === "/api/tool") return json([]);
      if (request.method === "GET" && url.pathname === "/api/vcs") return json({ branch: null, status: "unknown" });
      if (request.method === "GET" && url.pathname === "/api/config/settings") return json(openChamberSettings);
      if ((request.method === "PUT" || request.method === "POST") && url.pathname === "/api/config/settings") {
        const body = await readJson(request);
        return json({ ...openChamberSettings, ...(body && typeof body === "object" ? body : {}) });
      }
      if (request.method === "GET" && url.pathname === "/api/openchamber/update-check") return json({ available: false });
      if (request.method === "GET" && url.pathname === "/api/openchamber/models-metadata") return json({});
      if (request.method === "GET" && url.pathname === "/api/opencode/upgrade-status") return json({ available: false, upgrade: { supported: false } });
      if (request.method === "GET" && url.pathname === "/api/fs/home") return json({ home: options.workspace.root });
      if (request.method === "GET" && url.pathname === "/api/fs/list") {
        return json({ directory: options.workspace.root, entries: [] });
      }
      if (request.method === "GET" && url.pathname === "/api/find/file") return json([]);
      const quotaMatch = url.pathname.match(/^\/api\/quota\/([^/]+)$/);
      if (request.method === "GET" && quotaMatch) {
        return json({
          providerId: decodeURIComponent(quotaMatch[1]!),
          providerName: decodeURIComponent(quotaMatch[1]!),
          ok: false,
          configured: false,
          error: "配额接口未接入",
          usage: null,
          fetchedAt: Date.now(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/config/skills") {
        return json({ skills: [], externalSkills: [] });
      }
      if (request.method === "GET" && url.pathname === "/api/git/identities") return json([]);
      if (request.method === "GET" && url.pathname === "/api/git/global-identity") return json(null);
      if (request.method === "GET" && url.pathname === "/api/git/check") return json({ isGitRepository: false });
      if (request.method === "GET" && url.pathname === "/api/git/status") {
        return json({ isGitRepository: false, files: [], branch: null, ahead: 0, behind: 0 });
      }
      if (request.method === "GET" && (url.pathname === "/api/event" || url.pathname === "/api/global/event")) {
        return globalEventStream(globalEvents, globalListeners);
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const entries = await listSessions(options.workspace.root);
        return json(entries.map((entry) => openCodeSession(entry.id, entry.updatedAt, options.workspace.root, codeModel)));
      }
      if (request.method === "GET" && url.pathname === "/api/experimental/session") {
        const entries = await listSessions(options.workspace.root);
        return json(entries.map((entry) => openCodeSession(entry.id, entry.updatedAt, options.workspace.root, codeModel)));
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : `session-${crypto.randomUUID().slice(0, 8)}`;
        validateSessionId(id);
        await options.sessions.save(id, []);
        const session = openCodeSession(id, new Date().toISOString(), options.workspace.root, codeModel);
        sendGlobal("session.created", { directory: options.workspace.root, info: session });
        return json(session);
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        return json({ sessions: await listSessions(options.workspace.root) });
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,64})$/);
      if (request.method === "GET" && sessionMatch) {
        const id = sessionMatch[1]!;
        validateSessionId(id);
        return json({ id, ...(await options.sessions.loadSnapshot(id)) });
      }
      if ((request.method === "PATCH" || request.method === "DELETE") && sessionMatch) {
        const id = sessionMatch[1]!;
        validateSessionId(id);
        if (activeBySession.has(id)) return json({ error: "运行中的会话不能修改" }, 409);
        if (request.method === "DELETE") {
          const deleted = await options.sessions.delete(id);
          return deleted ? json({ ok: true, id }) : json({ error: "会话不存在" }, 404);
        }
        const body = await readJson(request);
        const nextId = requireString(body, "name").trim();
        validateSessionId(nextId);
        if (activeBySession.has(nextId)) return json({ error: "目标会话正在运行" }, 409);
        await options.sessions.rename(id, nextId);
        return json({ ok: true, id, name: nextId });
      }
      if (request.method === "GET" && url.pathname === "/api/session/status") {
        return json(Object.fromEntries([...activeBySession].map((id) => [id, { type: "busy" }])));
      }
      const opencodeSessionResourceMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})$/);
      if ((request.method === "PATCH" || request.method === "DELETE") && opencodeSessionResourceMatch) {
        const id = opencodeSessionResourceMatch[1]!;
        validateSessionId(id);
        if (activeBySession.has(id)) return json({ error: "运行中的会话不能修改" }, 409);
        if (request.method === "DELETE") {
          const deleted = await options.sessions.delete(id);
          if (deleted) sendGlobal("session.deleted", { directory: options.workspace.root, sessionID: id });
          return deleted ? json(true) : json({ error: "会话不存在" }, 404);
        }
        const body = await readJson(request);
        const title = typeof body.title === "string" ? body.title : id;
        return json({ ...openCodeSession(id, new Date().toISOString(), options.workspace.root, codeModel), title });
      }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson(request);
        const sessionId = requireString(body, "sessionId");
        const task = requireString(body, "task").trim();
        validateSessionId(sessionId);
        if (!task) return json({ error: "任务不能为空" }, 400);
        const run = launchRun(sessionId, task);
        return run ? json({ runId: run.id }) : json({ error: "该会话已有运行中的任务或任务为空" }, 409);
      }
      const opencodeSessionMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})$/);
      const opencodeMessageMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/message$/);
      const opencodePromptMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/prompt_async$/);
      const opencodeAbortMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/abort$/);
      if (request.method === "GET" && opencodeSessionMatch) {
        const id = opencodeSessionMatch[1]!;
        validateSessionId(id);
        const snapshot = await options.sessions.loadSnapshot(id);
        return json(openCodeSession(id, snapshot.updatedAt ?? new Date().toISOString(), options.workspace.root, codeModel));
      }
      if (request.method === "GET" && opencodeMessageMatch) {
        const id = opencodeMessageMatch[1]!;
        validateSessionId(id);
        const snapshot = await options.sessions.loadSnapshot(id);
        return json(openCodeMessages(id, snapshot.messages, codeModel, options.workspace.root));
      }
      if (request.method === "GET" && url.pathname === "/api/permission") {
        return json([...runs.values()].flatMap((run) => run.approval ? [{
          id: run.id,
          sessionID: run.sessionId,
          permission: "run_command",
          patterns: [run.approval.command.join(" ")],
          metadata: { command: run.approval.command.join(" "), cwd: run.directory },
          always: [],
        }] : []));
      }
      if (request.method === "GET" && url.pathname === "/api/question") return json([]);
      if (request.method === "GET" && url.pathname === "/api/mcp") return json({});
      if (request.method === "GET" && url.pathname === "/api/lsp") return json([]);
      const opencodeTodoMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})\/todo$/);
      if (request.method === "GET" && opencodeTodoMatch) return json([]);
      if (request.method === "POST" && opencodePromptMatch) {
        const id = opencodePromptMatch[1]!;
        const body = await readJson(request);
        const parts = Array.isArray(body.parts) ? body.parts : [];
        const task = parts
          .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
          .map((part) => typeof part.text === "string" ? part.text : "")
          .filter(Boolean)
          .join("\n");
        const messageID = typeof body.messageID === "string" ? body.messageID : undefined;
        const run = launchRun(id, task, messageID);
        return run ? json({}) : json({ error: "该会话已有运行中的任务或任务为空" }, 409);
      }
      if (request.method === "POST" && opencodeAbortMatch) {
        const run = [...runs.values()].find((candidate) => candidate.sessionId === opencodeAbortMatch[1] && !candidate.done);
        if (!run) return json(false);
        run.controller.abort(new Error("Cancelled by user"));
        return json(true);
      }
      const permissionReplyMatch = url.pathname.match(/^\/api\/permission\/([A-Za-z0-9_-]+)\/reply$/);
      if (request.method === "POST" && permissionReplyMatch) {
        const run = runs.get(permissionReplyMatch[1]!);
        if (!run?.approval) return json({ error: "权限请求不存在" }, 404);
        const body = await readJson(request);
        const reply = body.reply;
        if (reply !== "once" && reply !== "always" && reply !== "reject") {
          return json({ error: "reply 必须是 once、always 或 reject" }, 400);
        }
        run.approval.resolve(reply !== "reject");
        run.approval = undefined;
        sendGlobal("permission.replied", { directory: run.directory, sessionID: run.sessionId, requestID: run.id, response: reply });
        return json(true);
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)$/);
      if (runMatch && request.method === "POST") {
        const run = runs.get(runMatch[1]!);
        if (!run) return json({ error: "运行不存在" }, 404);
        const body = await readJson(request);
        if (body.action === "cancel") run.controller.abort(new Error("Cancelled by user"));
        else if (body.action === "approval" && run.approval) {
          run.approval.resolve(body.approved === true);
          run.approval = undefined;
          sendGlobal("permission.replied", {
            directory: run.directory,
            sessionID: run.sessionId,
            requestID: run.id,
            response: body.approved === true ? "once" : "reject",
          });
        } else return json({ error: "无效的运行操作" }, 400);
        return json({ ok: true });
      }
      const eventsMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const run = runs.get(eventsMatch[1]!);
        if (!run) return json({ error: "运行不存在" }, 404);
        return eventStream(run);
      }
      return serveStatic(url.pathname, openChamberAvailable, openChamberDist);
    },
  });

  return { server, close: () => server.stop() };
}

function eventStream(run: WebRun): Response {
  let listener: ((chunk: string) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (chunk: string): void => controller.enqueue(encoder.encode(chunk));
      for (const event of run.events) write(event);
      if (run.done) {
        controller.close();
        return;
      }
      listener = (chunk: string): void => {
        write(chunk);
        if (chunk.includes("event: run_closed\n")) {
          run.listeners.delete(listener!);
          controller.close();
        }
      };
      run.listeners.add(listener);
    },
    cancel() {
      if (listener) run.listeners.delete(listener);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function listSessions(root: string): Promise<Array<{ id: string; updatedAt: string }>> {
  try {
    const entries = await readdir(join(root, ".andi-agent", "sessions"), { withFileTypes: true });
    const sessions: Array<{ id: string; updatedAt: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      const stat = await Bun.file(join(root, ".andi-agent", "sessions", entry.name)).stat();
      sessions.push({ id, updatedAt: stat.mtime?.toISOString() ?? "" });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function serializeResult(result: AgentRunResult): { runId: string; output: string; usage: RunUsage; messages: Message[] } {
  return { runId: result.runId, output: result.output, usage: result.usage, messages: result.messages };
}

function openCodeProject(root: string): Record<string, unknown> {
  return { id: root, worktree: root, vcs: "git", sandboxes: [], time: { created: Date.now(), updated: Date.now() } };
}

function openCodeSession(id: string, updatedAt: string, directory: string, model: OpenCodeModel): Record<string, unknown> {
  const now = Date.parse(updatedAt) || Date.now();
  return {
    id,
    slug: id,
    projectID: directory,
    directory,
    project: { id: directory, name: basename(directory), worktree: directory },
    title: id,
    agent: "build",
    model: { id: model.modelID, providerID: model.providerID },
    version: "andi-agent",
    time: { created: now, updated: now },
  };
}

function openCodeMessageInfo(
  id: string,
  sessionID: string,
  role: "user" | "assistant",
  directory: string,
  model: OpenCodeModel,
  parentID?: string,
): Record<string, unknown> {
  const common = {
    id,
    sessionID,
    role,
    time: { created: Date.now(), ...(role === "assistant" ? { completed: Date.now() } : {}) },
    directory,
  };
  if (role === "user") {
    return { ...common, agent: "build", model };
  }
  return {
    ...common,
    parentID: parentID ?? id,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function openCodeMessages(
  sessionID: string,
  messages: readonly Message[],
  model: OpenCodeModel,
  directory: string,
): Array<Record<string, unknown>> {
  let parentID: string | undefined;
  return messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const id = `msg_${sessionID}_${index}`;
    const content = typeof message.content === "string" ? message.content : "";
    if (message.role === "user") parentID = id;
    return [{
      info: openCodeMessageInfo(id, sessionID, message.role, directory, model, message.role === "assistant" ? parentID : undefined),
      parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text: content }],
    }];
  });
}

function emitOpenCodeAgentEvent(
  run: WebRun,
  event: AgentEvent,
  sendGlobal: (type: string, properties: Record<string, unknown>) => void,
  model: OpenCodeModel,
): void {
  const base = { directory: run.directory, sessionID: run.sessionId };
  if (event.type === "model_text_delta") {
    run.assistantText += event.delta;
    sendGlobal("message.part.delta", { ...base, messageID: run.assistantMessageId, partID: run.assistantPartId, field: "text", delta: event.delta });
    return;
  }
  if (event.type === "tool_started") {
    sendGlobal("message.part.updated", {
      ...base,
      part: {
        id: `tool_${event.toolCallId}`,
        sessionID: run.sessionId,
        messageID: run.assistantMessageId,
        type: "tool",
        tool: event.toolName,
        callID: event.toolCallId,
        state: { status: "running", input: {} },
      },
    });
    return;
  }
  if (event.type === "tool_completed") {
    sendGlobal("message.part.updated", {
      ...base,
      part: {
        id: `tool_${event.toolCallId}`,
        sessionID: run.sessionId,
        messageID: run.assistantMessageId,
        type: "tool",
        tool: event.toolName,
        callID: event.toolCallId,
        state: { status: event.ok ? "completed" : "error", time: { end: Date.now() }, output: event.ok ? "完成" : "失败" },
      },
    });
    return;
  }
  if (event.type === "agent_completed" || event.type === "agent_cancelled" || event.type === "agent_failed") {
    sendGlobal("message.updated", {
      ...base,
      info: openCodeMessageInfo(run.assistantMessageId, run.sessionId, "assistant", run.directory, model, run.userMessageId),
    });
    sendGlobal("message.part.updated", {
      ...base,
      part: { id: run.assistantPartId, sessionID: run.sessionId, messageID: run.assistantMessageId, type: "text", text: run.assistantText },
    });
    sendGlobal("session.status", { ...base, status: { type: "idle" } });
    sendGlobal("session.idle", base);
  }
}

function globalEventStream(events: readonly string[], listeners: Set<(chunk: string) => void>): Response {
  let listener: ((chunk: string) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (chunk: string): void => controller.enqueue(encoder.encode(chunk));
      for (const event of events) write(event);
      listener = (chunk: string): void => write(chunk);
      listeners.add(listener);
    },
    cancel() {
      if (listener) listeners.delete(listener);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string") throw new Error(`字段 ${key} 必须是字符串`);
  return body[key] as string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function serveStatic(pathname: string, openChamberAvailable: boolean, openChamberDist: string): Promise<Response> {
  if (openChamberAvailable) {
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = Bun.file(join(openChamberDist, requested));
    const file = await candidate.exists() ? candidate : Bun.file(join(openChamberDist, "index.html"));
    return new Response(file);
  }
  const path = pathname === "/" ? "/index.html" : pathname;
  return new Response(Bun.file(join(import.meta.dir, "../web", path.slice(1))));
}

async function buildWebBundle(workspaceRoot: string): Promise<string> {
  const outputDirectory = join(workspaceRoot, ".andi-agent", "web");
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../web/app.js")],
    target: "browser",
    outdir: outputDirectory,
    minify: false,
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  return await Bun.file(join(outputDirectory, "app.js")).text();
}
