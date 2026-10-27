// The background of the extension - a service worker in Chrome and Yandex
// Browser, an event page in Firefox: the connection to Coddy, the tab groups,
// the website approvals, the commands, and the messages of the extension's
// own pages, the side panel among them.

import { Connection } from "./connection.js";
import { Groups } from "./groups.js";
import { Approvals } from "./approvals.js";
import { Commands, ACTIONS } from "./commands.js";
import { Debugger, cdpInput } from "./input.js";
import { pageInput } from "./pageinput.js";
import { indicator } from "./indicator.js";
import { api, action, capabilities } from "./platform.js";
import { serverURL, checkKey, checkName, isWebPage, siteEntry } from "./policy.js";

const version = api.runtime.getManifest().version;
const caps = capabilities(api);

function storeOf(area, key) {
  return {
    get: async () => (await api.storage[area].get(key))[key],
    set: (value) => api.storage[area].set({ [key]: value }),
  };
}

let settings = { address: "", key: "", name: "", id: "", enabled: false };
// The grant names the current selection. Stop replaces it, so a command
// Coddy sent before the Stop is refused whenever it arrives.
let grant = crypto.randomUUID();

const groups = new Groups(api, storeOf("session", "groups"));
// The sites allowed always outlive the browser; what one chat was allowed
// ends with it.
const approvals = new Approvals({
  store: storeOf("local", "grants"),
  sessionStore: storeOf("session", "chatGrants"),
  onChange: () => void approvalsChanged(),
  home: () => settings.address || "",
});
const commands = new Commands({
  api,
  groups,
  approvals,
  settings: () => settings,
  grant: () => grant,
  publish: () => publish(),
});
// Input through the debugger where the browser has it, through the page
// where it has not (Firefox).
commands.input = caps.debugger
  ? cdpInput(new Debugger(api))
  : pageInput(api, (tabId, action, params) => commands.script(tabId, action, params));

const connection = new Connection({
  WebSocket,
  settings: () => settings,
  version,
  actions: ACTIONS,
  grant: () => grant,
  setup(peer) {
    peer.onRequest("browser/command", (cmd, { signal }) => commands.handle(cmd, signal));
    peer.onNotification("$/cancelRequest", ({ id }) => peer.cancel(id));
    peer.onNotification("browser/turnEnded", ({ sessionId }) => turnEnded(sessionId));
  },
  onReady: () => publish(),
  onStatus: () => void badge(),
});
// Side panels that are open: a website question shows in them instead of a
// window of its own.
const panels = new Set();

// ready settles once the stored state is loaded. Every listener waits for it:
// an event that woke the worker must not act on the empty defaults - a Stop
// would write them over the stored approvals. It starts before any listener
// is registered, so none can reach it before it exists.
const ready = initialize();
ready.catch((e) => connection.setStatus(String(e?.message || e)));

function whenReady(fn) {
  return ready.catch(() => {}).then(fn);
}

let publishing = Promise.resolve();
// publish announces every tab Coddy may reach, in order, so an announcement
// never overtakes a newer one. A Stop while the tabs are read makes the list
// stale, and the Stop publishes the new one itself.
function publish() {
  publishing = publishing
    .catch(() => {})
    .then(async () => {
      if (!connection.connected()) return;
      const g = grant;
      const tabs = await groups.tabs();
      if (g !== grant || !connection.connected()) return;
      connection.peer?.notify("browser/tabs", { tabs, grant: g });
    });
  return publishing;
}

let publishTimer;
function publishSoon() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => void publish(), 150);
}

async function turnEnded(sessionId) {
  await groups.setWorking({ id: sessionId }, false);
  const chat = groups.state.chats[sessionId];
  if (!chat) return;
  for (const tab of await api.tabs.query({}))
    if (tab.groupId === chat.groupId)
      await api.scripting.executeScript({ target: { tabId: tab.id }, func: indicator, args: [false, ""] }).catch(() => {});
}

async function badge() {
  const waiting = approvals.list().length;
  const text = waiting ? "!" : connection.connected() ? "" : settings.enabled ? "…" : "";
  await action.setBadgeText({ text }).catch(() => {});
  if (waiting) await action.setBadgeBackgroundColor({ color: "#d97706" }).catch(() => {});
}

let approvalWindow = null;
async function approvalsChanged() {
  await badge();
  const pending = approvals.list();
  // An open side panel shows the question itself.
  if (!pending.length || panels.size) return;
  // The question needs a person: a small window of the extension's own, the
  // way a site permission prompt of the browser comes up.
  if (approvalWindow !== null) {
    const alive = await api.windows.get(approvalWindow).catch(() => null);
    if (alive) {
      await api.windows.update(approvalWindow, { focused: true }).catch(() => {});
      return;
    }
  }
  const w = await api.windows
    .create({ url: api.runtime.getURL("approval.html"), type: "popup", width: 420, height: 560, focused: true })
    .catch(() => null);
  approvalWindow = w?.id ?? null;
  const first = pending[0];
  await api.notifications
    .create(`coddy-approval-${first.id}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: first.kind === "chat" ? "A chat of another Coddy asks to use this browser" : "Coddy asks to use a website",
      message:
        first.kind === "chat"
          ? `${first.session.title || "A chat"}\non ${first.session.node}`
          : `${first.origin}\nfor ${first.session.title || "a chat"}`,
    })
    .catch(() => {});
}

async function stop() {
  grant = crypto.randomUUID();
  approvals.cancelAll();
  await approvals.forgetRemote();
  await groups.stopAll();
  await commands.input.detachAll();
  for (const tab of await api.tabs.query({}))
    await api.scripting.executeScript({ target: { tabId: tab.id }, func: indicator, args: [false, ""] }).catch(() => {});
  if (connection.connected()) {
    connection.peer.notify("browser/stop");
    await publish();
  }
}

// currentTab is the page the person looks at in a window: its active tab, or,
// when that is a page of the extension itself (the panel opened as a tab), the
// web page they looked at last.
async function currentTab(windowId) {
  const tabs = await api.tabs.query(windowId ? { windowId } : { lastFocusedWindow: true });
  const active = tabs.find((t) => t.active);
  if (active && isWebPage(active.url || "")) return active;
  if (active && !active.url?.startsWith(api.runtime.getURL(""))) return active;
  return tabs
    .filter((t) => isWebPage(t.url || ""))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function state(msg = {}) {
  const active = await currentTab(msg.windowId);
  let current = null;
  if (active && isWebPage(active.url || "")) {
    const owner = groups.ownerOf(active);
    current = {
      id: active.id,
      title: active.title || "",
      url: active.url,
      owner,
      chat: owner ? groups.state.chats[owner]?.title || "" : "",
    };
  }
  return {
    settings: {
      address: settings.address,
      name: settings.name,
      enabled: settings.enabled,
      keySet: !!settings.key,
    },
    status: connection.status,
    server: connection.connected() ? connection.server : null,
    current,
    tabs: await groups.tabs(),
    chats: groups.chats(),
    pending: approvals.list(),
    allowed: approvals.grants.always,
    allowAll: approvals.grants.all,
    version,
  };
}

async function save(msg) {
  const address = serverURL(msg.address);
  const key = msg.key ? checkKey(msg.key) : settings.key;
  if (!key) throw new Error("Enter the extension key");
  if (address !== settings.address && !msg.key) throw new Error("Enter the key of the new server");
  settings = { ...settings, address, key, name: checkName(msg.name), enabled: true };
  await api.storage.local.set({ settings });
  await stop();
  connection.connect();
}

const handlers = {
  state,
  save,
  async disconnect() {
    settings = { ...settings, enabled: false };
    await api.storage.local.set({ settings });
    await stop();
    connection.close();
  },
  async shareCurrent({ tabId }) {
    await groups.share(tabId);
    await publish();
  },
  async unshare({ tabId }) {
    await groups.unshare(tabId);
    await publish();
  },
  stop,
  // panelOpen answers the side panel opening: the web UI of the server the
  // extension is connected to, and a one-time ticket that signs it in.
  async panelOpen() {
    if (!connection.connected()) throw new Error("Not connected to Coddy");
    const opened = await connection.peer.request("panel/open", {});
    return { webUI: settings.address, ticket: opened.ticket, browserId: settings.id };
  },
  // adopt gives the tab the person writes from to the chat a turn of the
  // panel's web UI is for, before the turn starts.
  async adopt({ tabId, sessionId, title }) {
    if (!connection.connected()) throw new Error("Not connected to Coddy");
    const tab = await groups.adopt(tabId, { id: sessionId, title: title || "" });
    await publish();
    return { browser_id: settings.id, tab_id: tab.id, url: tab.url, title: tab.title || "" };
  },
  async decide({ id, choice }) {
    await approvals.decide(id, choice);
  },
  async revoke({ origin }) {
    await approvals.revoke(origin);
  },
  async allowSite({ site }) {
    const entry = siteEntry(site);
    await approvals.addAlways(entry);
    return entry;
  },
  async setAllowAll({ on }) {
    await approvals.setAll(on);
  },
};

api.runtime.onConnect.addListener((port) => {
  const own = port.sender?.id === api.runtime.id && port.sender?.url?.startsWith(api.runtime.getURL(""));
  if (port.name !== "coddy-panel" || !own) {
    port.disconnect();
    return;
  }
  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));
});

api.runtime.onMessage.addListener((msg, sender, respond) => {
  const own = sender.id === api.runtime.id && sender.url?.startsWith(api.runtime.getURL(""));
  // A page reaches the worker only through the indicator's Stop button,
  // which runs in the extension's isolated world of that page.
  const fromIndicator = sender.id === api.runtime.id && sender.tab && msg?.type === "stop" && msg.from === "indicator";
  if (!own && !fromIndicator) return false;
  const handler = Object.hasOwn(handlers, msg?.type) ? handlers[msg.type] : null;
  if (!handler) return false;
  // A message that woke the worker waits for the state it changes.
  whenReady(() => handler(msg)).then(
    (value) => respond({ value: value ?? null }),
    (e) => respond({ error: String(e?.message || e) }),
  );
  return true;
});

api.tabs.onUpdated.addListener((id, info, tab) =>
  whenReady(() => {
    if (info.url || info.title || "groupId" in info || info.status === "complete")
      if (groups.ownerOf(tab) !== null || "groupId" in info) publishSoon();
  }),
);
api.tabs.onRemoved.addListener(() => whenReady(publishSoon));
api.tabs.onAttached?.addListener(() => whenReady(publishSoon));
api.tabGroups.onRemoved.addListener((group) =>
  whenReady(async () => {
    await groups.groupRemoved(group.id);
    publishSoon();
  }),
);
api.windows.onRemoved.addListener((id) => {
  if (id === approvalWindow) approvalWindow = null;
  if (id === panelWindow) panelWindow = null;
});
api.notifications.onClicked.addListener(() => whenReady(approvalsChanged));
api.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void api.runtime.openOptionsPage();
});
api.alarms.onAlarm.addListener(() =>
  whenReady(() => {
    // A worker woken by the alarm after the browser tore it down finds no
    // socket and dials again; a refused key or a scheduled retry waits.
    if (settings.enabled && connection.idle()) connection.connect();
  }),
);

// The toolbar button opens the web UI beside the page: the side panel in
// Chrome, the sidebar in Firefox, a window of its own beside the browser's
// where neither exists (Yandex Browser).
let panelWindow = null;
if (!caps.sidePanel) {
  action.onClicked.addListener((tab) => {
    // Firefox opens a sidebar only in the call that answers the click.
    if (caps.sidebar) {
      void api.sidebarAction.toggle();
      return;
    }
    void openPanelWindow(tab?.windowId);
  });
}

async function openPanelWindow(windowId) {
  if (panelWindow !== null && (await api.windows.get(panelWindow).catch(() => null))) {
    await api.windows.update(panelWindow, { focused: true }).catch(() => {});
    return;
  }
  const beside = windowId ? await api.windows.get(windowId).catch(() => null) : null;
  const width = 440;
  const place = beside
    ? { left: Math.max(0, beside.left + beside.width - width), top: beside.top, height: beside.height }
    : { height: 800 };
  const url = api.runtime.getURL(`panel.html${beside ? `?window=${beside.id}` : ""}`);
  const w = await api.windows.create({ url, type: "popup", width, focused: true, ...place }).catch(() => null);
  panelWindow = w?.id ?? null;
}

async function initialize() {
  await api.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  // The toolbar button opens the web UI beside the page, as a side panel.
  if (caps.sidePanel) await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await api.alarms.create("coddy-keepalive", { periodInMinutes: 0.5 });
  const stored = (await api.storage.local.get("settings")).settings || {};
  settings = { ...settings, ...stored };
  if (!settings.id) {
    settings.id = crypto.randomUUID();
    await api.storage.local.set({ settings });
  }
  await groups.load();
  await approvals.load();
  connection.connect();
}


