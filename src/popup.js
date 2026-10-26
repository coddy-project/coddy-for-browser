import { request, el, showError, statusClass } from "./ui.js";

const approvalOnly = new URLSearchParams(location.search).has("approval");
if (approvalOnly) document.body.classList.add("approval");
const $ = (id) => document.getElementById(id);
let rendered = "";

const choices = [
  ["chat", "Allow for this chat", "primary"],
  ["always", "Always allow", ""],
  ["deny", "Decline", "danger"],
];

function approvalCard(p) {
  const card = el("div", { class: "card approval" });
  card.append(
    el("strong", {}, "Coddy asks to use a website"),
    el("p", { class: "origin" }, p.origin),
    el("p", { class: "muted" }, `To ${p.action} for the chat “${p.session.title || p.session.id}”.`),
  );
  const row = el("div", { class: "row" });
  for (const [choice, label, kind] of choices) {
    const b = el("button", { type: "button", class: kind }, label);
    b.onclick = () =>
      request({ type: "decide", id: p.id, choice })
        .then(refresh)
        .catch(showError);
    row.append(b);
  }
  card.append(row);
  return card;
}

function currentCard(s) {
  const box = $("current");
  box.replaceChildren();
  const c = s.current;
  if (!c) {
    box.append(el("p", { class: "muted" }, "This page cannot be shared: Coddy works with ordinary web pages only."));
    return;
  }
  box.append(el("strong", { class: "title" }, c.title || c.url), el("p", { class: "muted host" }, new URL(c.url).host));
  let label, action, note;
  if (c.owner === null) {
    note = "Not shared. Coddy cannot see or use this tab.";
    label = "Share this tab with Coddy";
    action = () => request({ type: "shareCurrent", tabId: c.id });
  } else if (c.owner === "") {
    note = "Shared: it is in the Coddy tab group, and any chat may take it.";
    label = "Stop sharing";
    action = () => request({ type: "unshare", tabId: c.id });
  } else {
    note = `Used by the chat “${c.chat}”.`;
    label = "Take this tab back";
    action = () => request({ type: "unshare", tabId: c.id });
  }
  const b = el("button", { type: "button", class: c.owner === null ? "primary" : "" }, label);
  b.onclick = () => action().then(refresh).catch(showError);
  box.append(el("p", {}, note), b);
}

async function refresh() {
  let s;
  try {
    s = await request({ type: "state" });
  } catch (e) {
    showError(e);
    return;
  }
  const status = $("status");
  status.textContent = s.status;
  status.className = "status " + statusClass(s.status);
  const next = JSON.stringify([s.current, s.chats, s.pending, s.settings, s.tabs.length]);
  if (next === rendered) return;
  rendered = next;
  const approvals = $("approvals");
  approvals.replaceChildren(...s.pending.map(approvalCard));
  if (approvalOnly) {
    if (!s.pending.length) window.close();
    return;
  }
  $("setup").hidden = s.settings.enabled && s.settings.keySet;
  currentCard(s);
  $("chats-section").hidden = !s.chats.length;
  $("chats").replaceChildren(
    ...s.chats.map((c) =>
      el("li", { class: c.working ? "working" : "" }, el("span", {}, c.title), el("small", { class: "muted" }, c.working ? "working" : "idle")),
    ),
  );
}

$("open-setup").onclick = $("settings").onclick = () => chrome.runtime.openOptionsPage();
$("stop").onclick = () =>
  request({ type: "stop" })
    .then(refresh)
    .catch(showError);

await refresh();
setInterval(refresh, 1000);
