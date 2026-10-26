// The side panel: a chat with Coddy next to the page. The tab the person
// writes from goes into the chat's tab group, so the agent can work in it.
import { request, el, showError, statusClass } from "./ui.js";
import { approvalCard } from "./cards.js";
import { render } from "./md.js";

const $ = (id) => document.getElementById(id);
const port = chrome.runtime.connect({ name: "coddy-panel" });
const replies = new Map();
let nextID = 1;
let windowId;
let sessionId = "";
let busy = false;
let state = null;
let answer = null;
let answerText = "";
const tools = new Map();
const cards = new Map();
let rendered = "";

// call asks the service worker to run a chat request on Coddy.
function call(type, data = {}) {
  const id = nextID++;
  return new Promise((resolve, reject) => {
    replies.set(id, { resolve, reject });
    port.postMessage({ type, id, ...data });
  });
}

port.onMessage.addListener((msg) => {
  if (msg.type === "reply") {
    const r = replies.get(msg.id);
    replies.delete(msg.id);
    if (!r) return;
    msg.error ? r.reject(new Error(msg.error)) : r.resolve(msg.value);
    return;
  }
  if (msg.sessionId && msg.sessionId !== sessionId) return;
  if (msg.type === "update") onUpdate(msg.update);
  if (msg.type === "permission") showPermission(msg);
  if (msg.type === "question") showQuestion(msg);
  if (msg.type === "settled") {
    cards.get(msg.requestId)?.remove();
    cards.delete(msg.requestId);
  }
});

function scrollDown() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function setEmpty() {
  $("empty").hidden = $("messages").children.length > 1;
}

function addMessage(role, text) {
  const node = el("div", { class: `message ${role}` });
  if (role === "assistant") node.append(render(text));
  else node.textContent = text;
  $("messages").append(node);
  setEmpty();
  scrollDown();
  return node;
}

function onUpdate(u) {
  if (u.kind === "text") {
    if (!answer) answer = addMessage("assistant", "");
    answerText += u.text;
    answer.replaceChildren(render(answerText));
    scrollDown();
  }
  if (u.kind === "tool") {
    let row = tools.get(u.toolCallId);
    if (!row) {
      row = el("div", { class: "tool" }, el("span", { class: "tool-title" }, u.title || "tool"), el("span", { class: "tool-status" }));
      tools.set(u.toolCallId, row);
      $("messages").append(row);
      // Text after a tool call is a new paragraph of the answer.
      answer = null;
      answerText = "";
      setEmpty();
    }
    const status = u.status === "completed" ? "done" : u.status === "failed" ? "failed" : u.status === "cancelled" ? "stopped" : "working";
    row.dataset.status = status;
    row.querySelector(".tool-status").textContent = status;
    scrollDown();
  }
}

function showPermission(msg) {
  const card = el("div", { class: "card ask" }, el("strong", {}, `Allow ${msg.title || "this tool"}?`));
  if (msg.detail) card.append(el("pre", {}, msg.detail.slice(0, 1500)));
  const row = el("div", { class: "row" });
  for (const o of msg.options || []) {
    const b = el("button", { type: "button", class: o.kind?.startsWith("allow") ? "primary" : o.kind?.startsWith("reject") ? "danger" : "" }, o.name || o.optionId);
    b.onclick = () => call("answer", { requestId: msg.requestId, value: { optionId: o.optionId } }).catch(showError);
    row.append(b);
  }
  card.append(row);
  cards.set(msg.requestId, card);
  $("messages").append(card);
  setEmpty();
  scrollDown();
}

function showQuestion(msg) {
  const form = el("form", { class: "card ask" });
  const fields = [];
  for (const q of msg.questions || []) {
    const label = el("label", {}, q.question);
    const input = el("input", { list: `q-${msg.requestId}-${fields.length}`, placeholder: "Your answer" });
    const options = el("datalist", { id: `q-${msg.requestId}-${fields.length}` });
    for (const o of q.options || []) options.append(el("option", { value: o.label }));
    label.append(input, options);
    form.append(label);
    fields.push(input);
  }
  form.append(el("button", { type: "submit", class: "primary" }, "Answer"));
  form.onsubmit = (e) => {
    e.preventDefault();
    call("answer", { requestId: msg.requestId, value: { answers: fields.map((f) => (f.value ? [f.value] : [])) } }).catch(showError);
  };
  cards.set(msg.requestId, form);
  $("messages").append(form);
  setEmpty();
  scrollDown();
}

function setBusy(on) {
  busy = on;
  $("send").classList.toggle("stop", on);
  $("send").title = on ? "Stop" : "Send";
  $("send").setAttribute("aria-label", on ? "Stop" : "Send");
  $("send").innerHTML = on
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>';
}

async function remember(id) {
  sessionId = id;
  await chrome.storage.session.set({ [`panel:${windowId}`]: id }).catch(() => {});
  await call("watch", { sessionId: id });
}

function clearMessages() {
  for (const node of [...$("messages").children]) if (node.id !== "empty") node.remove();
  tools.clear();
  cards.clear();
  answer = null;
  answerText = "";
  setEmpty();
}

async function openChat(id, title = "") {
  clearMessages();
  await remember(id);
  $("chat-title").textContent = title;
  if (!id) return;
  const { messages } = await call("messages", { sessionId: id });
  for (const m of messages) addMessage(m.role, m.text);
}

async function send(text) {
  if (!sessionId) {
    const created = await call("new");
    await remember(created.sessionId);
  }
  addMessage("user", text);
  answer = null;
  answerText = "";
  setBusy(true);
  try {
    const tab = state?.current;
    const result = await call("send", {
      sessionId,
      text,
      tabId: tab?.id,
      title: $("chat-title").textContent || text.slice(0, 40),
    });
    if (result?.notice) addMessage("notice", result.notice);
  } catch (e) {
    addMessage("notice", String(e.message || e));
  } finally {
    setBusy(false);
    answer = null;
    void refresh();
  }
}

$("composer").onsubmit = (e) => {
  e.preventDefault();
  if (busy) {
    void call("cancel", { sessionId }).catch(showError);
    return;
  }
  const text = $("prompt").value.trim();
  if (!text) return;
  $("prompt").value = "";
  showError(null);
  void send(text);
};
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
};
$("new").onclick = () => {
  if (busy) return;
  $("chat-title").textContent = "";
  void openChat("").catch(showError);
};
$("settings").onclick = $("open-settings").onclick = () => chrome.runtime.openOptionsPage();
$("stop-all").onclick = () =>
  request({ type: "stop" })
    .then(refresh)
    .catch(showError);
$("history").onclick = async () => {
  const list = $("chats");
  if (!list.hidden) {
    list.hidden = true;
    $("history").setAttribute("aria-expanded", "false");
    return;
  }
  try {
    const { chats } = await call("list");
    list.replaceChildren(
      ...(chats.length
        ? chats.map((c) => {
            const b = el("button", { type: "button", class: c.sessionId === sessionId ? "current" : "" }, c.title || c.sessionId);
            b.onclick = () => {
              list.hidden = true;
              $("history").setAttribute("aria-expanded", "false");
              $("chat-title").textContent = c.title || "";
              void openChat(c.sessionId, c.title || "").catch(showError);
            };
            return b;
          })
        : [el("p", { class: "muted" }, "No chats yet.")]),
    );
    list.hidden = false;
    $("history").setAttribute("aria-expanded", "true");
  } catch (e) {
    showError(e);
  }
};

function tabbar(s) {
  const bar = $("tabbar");
  const c = s.current;
  bar.replaceChildren();
  if (!c) {
    bar.append(el("span", { class: "muted" }, "Coddy works with ordinary web pages only."));
    return;
  }
  let note;
  if (c.owner === sessionId && sessionId) note = "in this chat";
  else if (c.owner === "") note = "shared with Coddy";
  else if (c.owner) note = `in the chat "${c.chat}"`;
  else note = "Coddy takes this tab when you send";
  // Sharing puts the tab where any chat of Coddy may take it - one from the
  // web UI or a messenger too; taking it back ungroups it.
  const shared = c.owner !== null;
  const toggle = el("button", { type: "button", class: "link" }, shared ? "Take back" : "Share");
  toggle.title = shared ? "Take this tab out of Coddy's tab groups" : "Put this tab in the Coddy tab group, where any chat may use it";
  toggle.onclick = () =>
    request({ type: shared ? "unshare" : "shareCurrent", tabId: c.id })
      .then(refresh)
      .catch(showError);
  bar.append(
    el("span", { class: "tab-title", title: c.url }, c.title || new URL(c.url).host),
    el("small", { class: "muted" }, note),
    el("span", { class: "spacer" }),
    toggle,
  );
}

async function refresh() {
  try {
    state = await request({ type: "state", windowId });
  } catch (e) {
    showError(e);
    return;
  }
  const status = $("status");
  status.title = state.status;
  status.textContent = state.status;
  status.className = "status dot-only " + statusClass(state.status);
  const offline = state.status !== "Connected";
  $("offline").hidden = !offline;
  $("offline-text").textContent = state.settings.enabled ? `Coddy: ${state.status}` : "Connect the extension to your Coddy server.";
  $("send").disabled = offline && !busy;
  tabbar(state);
  const next = JSON.stringify(state.pending);
  if (next !== rendered) {
    rendered = next;
    $("approvals").replaceChildren(...state.pending.map((p) => approvalCard(p, refresh)));
  }
}

windowId = (await chrome.windows.getCurrent()).id;
await refresh();
setInterval(refresh, 1000);
const saved = (await chrome.storage.session.get(`panel:${windowId}`).catch(() => ({})))[`panel:${windowId}`];
if (saved && state?.status === "Connected") await openChat(saved).catch(() => openChat(""));
else await remember("").catch(() => {});
