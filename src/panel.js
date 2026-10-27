// The side panel: the web UI of the Coddy server the extension is connected
// to, in a frame, under a strip of the extension's own - the tab you look at
// with Share and Take back, and the settings. The connection and Disconnect
// are on the settings page, Stop on the page Coddy works in. A turn sent from the web UI
// takes the tab you look at into its chat's tab group first. The same page is
// Chrome's side panel, Firefox's sidebar and, in Yandex Browser, a window of
// its own beside the browser's, which names that window in its address.
import { api } from "./platform.js";
import { request, el, showError } from "./ui.js";
import { approvalCard } from "./cards.js";
import { frameURL, listen } from "./frame.js";

const $ = (id) => document.getElementById(id);
// The worker counts open panels: a website question shows here instead of a
// window of its own.
api.runtime.connect({ name: "coddy-panel" });
let windowId;
let state = null;
let rendered = "";
let loaded = "";
let origin = "";

function tabbar(s) {
  const bar = $("tabbar");
  const c = s.current;
  bar.replaceChildren();
  if (!c) {
    bar.append(el("span", { class: "muted" }, "Coddy works with ordinary web pages only."));
    return;
  }
  let note;
  if (c.owner === "") note = "shared";
  else if (c.owner) note = `in "${c.chat}"`;
  else note = "taken when you send";
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
    toggle,
  );
}

// load puts the web UI in the frame, signed in with a fresh ticket.
async function load() {
  try {
    const opened = await request({ type: "panelOpen" });
    origin = new URL(opened.webUI).origin;
    const frame = $("webui");
    frame.src = frameURL(opened.webUI, opened.ticket, location.origin);
    frame.hidden = false;
    loaded = opened.webUI;
    showError(null);
  } catch (e) {
    showError(e);
  }
}

// unload takes the web UI out of the frame: the extension was switched to
// another server or off, and the old server's page must not keep asking the
// panel for tabs.
function unload() {
  const frame = $("webui");
  frame.src = "about:blank";
  frame.hidden = true;
  origin = "";
  loaded = "";
}

async function refresh() {
  try {
    state = await request({ type: "state", windowId });
  } catch (e) {
    showError(e);
    return;
  }
  if (loaded && (!state.settings.enabled || loaded !== state.settings.address)) unload();
  const offline = state.status !== "Connected";
  $("offline").hidden = !offline;
  $("offline-text").textContent = state.settings.enabled ? `Coddy: ${state.status}` : "Connect the extension to your Coddy server.";
  if (!offline && !loaded) await load();
  tabbar(state);
  const next = JSON.stringify(state.pending);
  if (next !== rendered) {
    rendered = next;
    $("approvals").replaceChildren(...state.pending.map((p) => approvalCard(p, refresh)));
  }
}

// applyTheme paints the panel's strip in the web UI's colours.
function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme.scheme;
  root.style.colorScheme = theme.scheme;
  for (const key of ["bg", "surface", "border", "text", "muted", "accent"]) root.style.setProperty(`--${key}`, theme[key]);
}

listen(window, {
  frame: () => $("webui").contentWindow,
  origin: () => origin,
  onTheme: applyTheme,
  async onTurn({ sessionId, title }) {
    const s = await request({ type: "state", windowId });
    if (!s.current || !sessionId) return null;
    return request({ type: "adopt", tabId: s.current.id, sessionId, title });
  },
});

$("settings").onclick = $("open-settings").onclick = () => api.runtime.openOptionsPage();

windowId = Number(new URLSearchParams(location.search).get("window")) || (await api.windows.getCurrent()).id;
await refresh();
setInterval(refresh, 1000);
