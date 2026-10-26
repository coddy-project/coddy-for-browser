// The service worker: the connection to Coddy, the tab groups, the website
// approvals and the commands, and the messages of the extension's own pages.

import { Connection } from "./connection.js";
import { Groups } from "./groups.js";
import { Approvals } from "./approvals.js";
import { Commands, ACTIONS } from "./commands.js";
import { Debugger } from "./input.js";
import { indicator } from "./indicator.js";
import { serverURL, checkKey, checkName, isWebPage } from "./policy.js";

const api = chrome;
const version = api.runtime.getManifest().version;

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
const approvals = new Approvals({
  store: storeOf("local", "grants"),
  onChange: () => void approvalsChanged(),
});
const dbg = new Debugger(api);
const commands = new Commands({
  api,
  groups,
  approvals,
  dbg,
  settings: () => settings,
  grant: () => grant,
  publish: () => publish(),
});

const connection = new Connection({
  WebSocket,
  settings: () => settings,
  version,
  actions: ACTIONS,
  setup(peer) {
    peer.onRequest("browser/command", (cmd, { signal }) => commands.handle(cmd, signal));
    peer.onNotification("$/cancelRequest", ({ id }) => peer.cancel(id));
    peer.onNotification("browser/turnEnded", ({ sessionId }) => turnEnded(sessionId));
  },
  onReady: () => publish(),
  onStatus: () => void badge(),
});

let publishing = Promise.resolve();
// publish announces every tab Coddy may reach, in order, so an announcement
// never overtakes a newer one.
function publish() {
  publishing = publishing
    .catch(() => {})
    .then(async () => {
      if (!connection.connected()) return;
      const tabs = await groups.tabs();
      connection.peer?.notify("browser/tabs", { tabs, grant });
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
  await api.action.setBadgeText({ text }).catch(() => {});
  if (waiting) await api.action.setBadgeBackgroundColor({ color: "#d97706" }).catch(() => {});
}

let approvalWindow = null;
async function approvalsChanged() {
  await badge();
  const pending = approvals.list();
  if (!pending.length) return;
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
    .create({ url: api.runtime.getURL("popup.html?approval=1"), type: "popup", width: 420, height: 560, focused: true })
    .catch(() => null);
  approvalWindow = w?.id ?? null;
  const first = pending[0];
  await api.notifications
    .create(`coddy-approval-${first.id}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Coddy asks to use a website",
      message: `${first.origin}\nfor ${first.session.title || "a chat"}`,
    })
    .catch(() => {});
}

async function stop() {
  grant = crypto.randomUUID();
  approvals.cancelAll();
  await groups.stopAll();
  await dbg.detachAll();
  for (const tab of await api.tabs.query({}))
    await api.scripting.executeScript({ target: { tabId: tab.id }, func: indicator, args: [false, ""] }).catch(() => {});
  if (connection.connected()) {
    connection.peer.notify("browser/stop");
    await publish();
  }
}

async function state() {
  const [active] = await api.tabs.query({ active: true, lastFocusedWindow: true });
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
  async decide({ id, choice }) {
    await approvals.decide(id, choice);
  },
  async revoke({ origin }) {
    await approvals.revoke(origin);
  },
};

api.runtime.onMessage.addListener((msg, sender, respond) => {
  const own = sender.id === api.runtime.id && sender.url?.startsWith(api.runtime.getURL(""));
  // A page reaches the worker only through the indicator's Stop button,
  // which runs in the extension's isolated world of that page.
  const fromIndicator = sender.id === api.runtime.id && sender.tab && msg?.type === "stop" && msg.from === "indicator";
  if (!own && !fromIndicator) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg)).then(
    (value) => respond({ value: value ?? null }),
    (e) => respond({ error: String(e?.message || e) }),
  );
  return true;
});

api.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url || info.title || "groupId" in info || info.status === "complete")
    if (groups.ownerOf(tab) !== null || "groupId" in info) publishSoon();
});
api.tabs.onRemoved.addListener(() => publishSoon());
api.tabs.onAttached?.addListener(() => publishSoon());
api.tabGroups.onRemoved.addListener(async (group) => {
  await groups.groupRemoved(group.id);
  publishSoon();
});
api.windows.onRemoved.addListener((id) => {
  if (id === approvalWindow) approvalWindow = null;
});
api.notifications.onClicked.addListener(() => void approvalsChanged());
api.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void api.runtime.openOptionsPage();
});
api.alarms.onAlarm.addListener(() => {
  // A service worker woken by the alarm after Chrome tore it down finds no
  // socket and dials again.
  if (settings.enabled && !connection.socket) connection.connect();
});

async function initialize() {
  await api.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
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

void initialize().catch((e) => connection.setStatus(String(e?.message || e)));
