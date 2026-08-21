import { marked } from "marked";
import katex from "katex";

const state = { session: "default", runId: null, source: null, sidebarOpen: localStorage.getItem("andi.sidebar.open") !== "false", mobileSidebarOpen: false };
const $ = (id) => document.getElementById(id);
const messages = $("messages");
const sessions = $("sessions");
const task = $("task");
const approval = $("approval");
const shell = document.querySelector(".shell");
const mobileMedia = window.matchMedia("(max-width: 700px)");

marked.setOptions({ breaks: true, gfm: true });

function applySidebarState() {
  const mobile = mobileMedia.matches;
  shell.classList.toggle("sidebar-collapsed", !mobile && !state.sidebarOpen);
  shell.classList.toggle("mobile-sidebar-open", mobile && state.mobileSidebarOpen);
  $("sidebar-toggle").setAttribute("aria-label", state.sidebarOpen ? "折叠侧边栏" : "展开侧边栏");
  $("sidebar-toggle").title = state.sidebarOpen ? "折叠侧边栏" : "展开侧边栏";
  localStorage.setItem("andi.sidebar.open", String(state.sidebarOpen));
}

function toggleSidebar() {
  if (mobileMedia.matches) state.mobileSidebarOpen = !state.mobileSidebarOpen;
  else state.sidebarOpen = !state.sidebarOpen;
  applySidebarState();
}

async function api(path, options) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function clearEmpty() {
  const empty = document.querySelector(".empty-state");
  if (empty) empty.remove();
}

function renderMarkdown(source) {
  const container = document.createElement("div");
  container.innerHTML = marked.parse(source);
  sanitize(container);
  renderMath(container);
  return container.innerHTML;
}

function sanitize(container) {
  container.querySelectorAll("script,style,iframe,object,embed,form").forEach((node) => node.remove());
  container.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || (name === "href" && value.startsWith("javascript:"))) element.removeAttribute(attribute.name);
    }
  });
}

function renderMath(container) {
  const pattern = /\\\[((?:.|\n)*?)\\\]|\$\$((?:.|\n)*?)\$\$|\\\((.*?)\\\)|\$([^$\n]+)\$/g;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("code,pre,a")) continue;
    if (pattern.test(node.nodeValue || "")) nodes.push(node);
    pattern.lastIndex = 0;
  }
  for (const node of nodes) {
    const source = node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      fragment.append(source.slice(cursor, start));
      const display = match[1] ?? match[2];
      const formula = display ?? match[3] ?? match[4] ?? "";
      const holder = document.createElement("span");
      holder.innerHTML = katex.renderToString(formula.trim(), { displayMode: display !== undefined, throwOnError: false });
      fragment.append(holder);
      cursor = start + match[0].length;
    }
    fragment.append(source.slice(cursor));
    node.replaceWith(fragment);
  }
}

function addMessage(role, text = "") {
  clearEmpty();
  const row = document.createElement("div");
  row.className = `message ${role}`;
  if (role === "assistant") row.innerHTML = '<div class="avatar">a</div>';
  const body = document.createElement("div");
  body.className = "message-body";
  if (role === "assistant") body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  row.append(body);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
  return body;
}

function updateAssistant(body, text) {
  body.innerHTML = renderMarkdown(text);
  messages.scrollTop = messages.scrollHeight;
}

function addTool(text) {
  const item = document.createElement("div");
  item.className = "tool";
  item.textContent = text;
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
}

async function loadSessions() {
  const data = await api("/api/sessions");
  sessions.innerHTML = "";
  const list = data.sessions.length ? data.sessions : [{ id: "default" }];
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "session-row";
    const button = document.createElement("button");
    button.className = `session ${item.id === state.session ? "active" : ""}`;
    button.textContent = item.id;
    button.onclick = () => selectSession(item.id);
    const actions = document.createElement("button");
    actions.className = "session-actions";
    actions.textContent = "⋯";
    actions.title = "会话操作";
    actions.onclick = (event) => { event.stopPropagation(); openSessionActions(item.id); };
    row.append(button, actions);
    sessions.append(row);
  }
}

async function openSessionActions(id) {
  const action = window.prompt(`会话“${id}”\n输入新名称进行重命名，输入 delete 删除：`, id);
  if (action === null || action.trim() === "" || action.trim() === id) return;
  if (action.trim().toLowerCase() === "delete") {
    if (!window.confirm(`确定删除会话“${id}”及其持久化文件吗？`)) return;
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.session === id) {
      state.session = "default";
      await selectSession("default");
    } else await loadSessions();
    return;
  }
  const nextId = action.trim();
  await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name: nextId }) });
  if (state.session === id) {
    state.session = nextId;
    $("session-title").textContent = nextId;
  }
  await loadSessions();
}

async function selectSession(id) {
  if (state.runId) return;
  state.mobileSidebarOpen = false;
  applySidebarState();
  state.session = id;
  $("session-title").textContent = id;
  const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
  messages.innerHTML = "";
  if (!data.messages.length) {
    messages.innerHTML = '<div class="empty-state"><div class="eyebrow">LOCAL CODING AGENT</div><h1>准备开始<br /><em>你的下一项工作。</em></h1><p>描述任务，andi 会先检查工作区，再执行必要的工具。</p></div>';
  } else {
    for (const message of data.messages) {
      if (message.role === "user") addMessage("user", message.content);
      if (message.role === "assistant" && message.content) addMessage("assistant", message.content);
      if (message.role === "tool") addTool(`工具结果 · ${message.name}`);
    }
  }
  await loadSessions();
}

function setRunning(running) {
  $("cancel").classList.toggle("hidden", !running);
  task.disabled = running;
  document.querySelector(".composer button").disabled = running;
}

function showApproval(command) {
  approval.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = "需要批准一条命令";
  const code = document.createElement("code");
  code.textContent = command.join(" ");
  approval.append(title, code);
  for (const [label, approved] of [["批准", true], ["拒绝", false]]) {
    const button = document.createElement("button");
    button.textContent = label;
    button.onclick = async () => {
      await api(`/api/runs/${state.runId}`, { method: "POST", body: JSON.stringify({ action: "approval", approved }) });
      approval.classList.add("hidden");
    };
    approval.append(button);
  }
  approval.classList.remove("hidden");
}

function handleEvent(event, assistantBody, output) {
  const data = JSON.parse(event.data);
  if (event.type === "model_text_delta") {
    output.text += data.delta;
    updateAssistant(assistantBody, output.text);
  } else if (event.type === "tool_started") addTool(`正在执行 · ${data.toolName}`);
  else if (event.type === "tool_completed") addTool(`${data.ok ? "完成" : "失败"} · ${data.toolName} · ${data.durationMs}ms`);
  else if (event.type === "approval_required") showApproval(data.command);
  else if (event.type === "run_closed") {
    state.runId = null;
    state.source?.close();
    state.source = null;
    approval.classList.add("hidden");
    setRunning(false);
    loadSessions();
  } else if (event.type === "run_failed") {
    output.text += `\n\n错误：${data.error}`;
    updateAssistant(assistantBody, output.text);
  }
}

async function sendTask(event) {
  event.preventDefault();
  const value = task.value.trim();
  if (!value || state.runId) return;
  task.value = "";
  addMessage("user", value);
  const assistantBody = addMessage("assistant");
  const output = { text: "" };
  setRunning(true);
  try {
    const data = await api("/api/runs", { method: "POST", body: JSON.stringify({ sessionId: state.session, task: value }) });
    state.runId = data.runId;
    state.source = new EventSource(`/api/runs/${data.runId}/events`);
    ["run_started", "model_text_delta", "tool_started", "tool_completed", "approval_required", "run_completed", "run_failed", "run_closed"].forEach((name) => state.source.addEventListener(name, (message) => handleEvent(message, assistantBody, output)));
    state.source.onerror = () => { if (state.runId) { output.text += "\n\n连接已断开，请重新打开会话查看状态。"; updateAssistant(assistantBody, output.text); } };
  } catch (error) {
    updateAssistant(assistantBody, `错误：${error.message}`);
    setRunning(false);
  }
}

$("composer").addEventListener("submit", sendTask);
$("task").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("new-session").onclick = async () => { state.session = `session-${Date.now()}`; await selectSession(state.session); };
$("cancel").onclick = () => state.runId && api(`/api/runs/${state.runId}`, { method: "POST", body: JSON.stringify({ action: "cancel" }) });
$("sidebar-toggle").onclick = toggleSidebar;
$("sidebar-backdrop").onclick = () => { state.mobileSidebarOpen = false; applySidebarState(); };
mobileMedia.addEventListener("change", () => { state.mobileSidebarOpen = false; applySidebarState(); });
applySidebarState();

(async () => {
  const boot = await api("/api/bootstrap");
  $("workspace").textContent = boot.workspace;
  $("model-label").textContent = `${boot.provider} / ${boot.model}`;
  await selectSession(state.session);
})().catch((error) => { $("model-label").textContent = error.message; });
