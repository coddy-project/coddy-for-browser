// Tabs Coddy may reach live in the browser's tab groups (Chrome, Yandex
// Browser, Firefox 139 and later), so the user sees them in the tab strip and
// moves them by dragging:
// - the shared group holds the tabs the user shares; any chat may take one;
// - every chat that works in the browser has a group of its own, holding the
//   tabs it took or opened; no other chat may act there.
// Every one of them is titled "Coddy" in Coddy's lilac, so its tabs are told
// apart from the rest at a glance; a chat's group gets an hourglass while the
// chat acts, and the side panel names the chat that holds a tab.
// Group ids last as long as the browser runs, so the bookkeeping lives in
// session storage and survives the service worker being torn down.

import { isWebPage } from "./policy.js";

export const GROUP_TITLE = "Coddy";
export const GROUP_COLOR = "purple";
const WORKING = "⏳ ";
const NONE = -1;

// chatTitle names a chat in the side panel: its title cut to fit, and for a
// chat of another Coddy the machine it runs on, which is never cut off.
export function chatTitle(session) {
  const node = session?.node ? ` (${String(session.node).slice(0, 20)})` : "";
  const room = 30 - node.length;
  const title = String(session?.title || "").trim() || String(session?.id || "").slice(-6);
  return (title.length > room ? title.slice(0, room - 1) + "…" : title) + node;
}

export class Groups {
  // api is chrome (or a fake in tests); store keeps {shared, chats}.
  constructor(api, store) {
    this.api = api;
    this.store = store;
    this.state = { shared: null, chats: {} };
    this.working = new Set();
    this.queue = Promise.resolve();
  }

  // run makes one change of the groups at a time: Stop waits for a tab
  // being opened, so the tab is ungrouped too, and two chats cannot both
  // take the same shared tab.
  run(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async load() {
    this.state = (await this.store.get()) || { shared: null, chats: {} };
    this.state.chats ||= {};
  }

  async save() {
    await this.store.set(this.state);
  }

  // ownerOf says whose a tab is: "" for the shared group, a session id for a
  // chat's group, null for a tab Coddy may not reach.
  ownerOf(tab) {
    if (!tab || tab.groupId === undefined || tab.groupId === NONE) return null;
    if (tab.groupId === this.state.shared) return "";
    for (const [sessionId, chat] of Object.entries(this.state.chats))
      if (chat.groupId === tab.groupId) return sessionId;
    return null;
  }

  // forgetMissing drops the groups the user closed or ungrouped away.
  async forgetMissing() {
    const alive = async (id) => {
      if (id === null || id === undefined) return false;
      try {
        await this.api.tabGroups.get(id);
        return true;
      } catch {
        return false;
      }
    };
    let changed = false;
    if (this.state.shared !== null && !(await alive(this.state.shared))) {
      this.state.shared = null;
      changed = true;
    }
    for (const [sessionId, chat] of Object.entries(this.state.chats))
      if (!(await alive(chat.groupId))) {
        delete this.state.chats[sessionId];
        changed = true;
      }
    if (changed) await this.save();
  }

  groupRemoved(groupId) {
    return this.run(() => this._groupRemoved(groupId));
  }

  _groupRemoved(groupId) {
    if (this.state.shared === groupId) this.state.shared = null;
    for (const [sessionId, chat] of Object.entries(this.state.chats))
      if (chat.groupId === groupId) delete this.state.chats[sessionId];
    return this.save();
  }

  // tabs is what the extension reports to Coddy: every web page in a Coddy
  // group, with the chat that holds it.
  async tabs() {
    await this.run(() => this.forgetMissing());
    const out = [];
    for (const tab of await this.api.tabs.query({})) {
      const owner = this.ownerOf(tab);
      if (owner === null || !isWebPage(tab.url || "")) continue;
      const entry = { id: tab.id, url: tab.url, title: (tab.title || "").slice(0, 1000) };
      if (owner) entry.sessionId = owner;
      out.push(entry);
    }
    return out.slice(0, 100);
  }

  async sharedGroup(windowId, tabId) {
    if (this.state.shared !== null) {
      try {
        await this.api.tabGroups.get(this.state.shared);
        await this.api.tabs.group({ tabIds: [tabId], groupId: this.state.shared });
        return this.state.shared;
      } catch {
        this.state.shared = null;
      }
    }
    const groupId = await this.api.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await this.api.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
    this.state.shared = groupId;
    await this.save();
    return groupId;
  }

  // share is the user handing a tab to Coddy: into the shared group.
  share(tabId) {
    return this.run(() => this._share(tabId));
  }

  async _share(tabId) {
    const tab = await this.api.tabs.get(tabId);
    if (!isWebPage(tab.url || "")) throw new Error("Only ordinary web pages can be shared");
    await this.sharedGroup(tab.windowId, tabId);
  }

  // unshare takes a tab out of every Coddy group; it stays open.
  unshare(tabId) {
    return this.run(() => this._unshare(tabId));
  }

  async _unshare(tabId) {
    await this.api.tabs.ungroup([tabId]);
  }

  async chatGroup(session, tab) {
    const chat = this.state.chats[session.id];
    if (chat) {
      try {
        await this.api.tabGroups.get(chat.groupId);
        await this.api.tabs.group({ tabIds: [tab.id], groupId: chat.groupId });
        await this.retitle(session);
        return chat.groupId;
      } catch {
        delete this.state.chats[session.id];
      }
    }
    const groupId = await this.api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    this.state.chats[session.id] = { groupId, title: chatTitle(session) };
    await this.api.tabGroups.update(groupId, { title: this.decorate(session.id), color: GROUP_COLOR });
    await this.save();
    return groupId;
  }

  // claim moves a tab the chat may take into the chat's group: a shared tab,
  // or one already its own. Anything else is refused.
  claim(tabId, session) {
    return this.run(() => this._claim(tabId, session));
  }

  async _claim(tabId, session) {
    const tab = await this.api.tabs.get(tabId);
    const owner = this.ownerOf(tab);
    if (owner === null) {
      const e = new Error("The tab is not shared with Coddy; ask the user to share it");
      e.reason = "not_shared";
      throw e;
    }
    if (owner && owner !== session.id) {
      const e = new Error("The tab is in another chat's tab group");
      e.reason = "other_chat";
      throw e;
    }
    if (owner === "") await this.chatGroup(session, tab);
    else await this.retitle(session);
    return this.api.tabs.get(tabId);
  }

  // adopt is the person giving a tab to a chat of the side panel: the tab
  // they write from goes into the chat's group whatever group it was in.
  adopt(tabId, session) {
    return this.run(() => this._adopt(tabId, session));
  }

  async _adopt(tabId, session) {
    const tab = await this.api.tabs.get(tabId);
    if (!isWebPage(tab.url || "")) throw new Error("Only ordinary web pages can be given to Coddy");
    if (this.ownerOf(tab) === session.id) {
      await this.retitle(session);
      return tab;
    }
    await this.chatGroup(session, tab);
    return this.api.tabs.get(tabId);
  }

  // open creates a tab for the chat, in its group, without taking focus.
  open(url, session) {
    return this.run(() => this._open(url, session));
  }

  async _open(url, session) {
    const chat = this.state.chats[session.id];
    let windowId;
    if (chat) {
      try {
        windowId = (await this.api.tabGroups.get(chat.groupId)).windowId;
      } catch {}
    }
    const tab = await this.api.tabs.create({ url, active: false, ...(windowId ? { windowId } : {}) });
    await this.chatGroup(session, tab);
    return tab;
  }

  // release hands the chat's tabs back to the shared group and answers their
  // ids.
  release(sessionId) {
    return this.run(() => this._release(sessionId));
  }

  async _release(sessionId) {
    const chat = this.state.chats[sessionId];
    if (!chat) return [];
    const tabs = (await this.api.tabs.query({})).filter((t) => t.groupId === chat.groupId);
    delete this.state.chats[sessionId];
    this.working.delete(sessionId);
    for (const tab of tabs) await this.sharedGroup(tab.windowId, tab.id);
    await this.save();
    return tabs.map((t) => t.id);
  }

  // stopAll is the user's Stop: every Coddy group is dissolved and every tab
  // stays open outside them.
  stopAll() {
    return this.run(() => this._stopAll());
  }

  async _stopAll() {
    const managed = (await this.api.tabs.query({})).filter((t) => this.ownerOf(t) !== null).map((t) => t.id);
    this.state = { shared: null, chats: {} };
    this.working.clear();
    await this.save();
    if (managed.length) await this.api.tabs.ungroup(managed);
  }

  decorate(sessionId) {
    return (this.working.has(sessionId) ? WORKING : "") + GROUP_TITLE;
  }

  async retitle(session) {
    const chat = this.state.chats[session.id];
    if (!chat) return;
    if (session.title) chat.title = chatTitle(session);
    try {
      await this.api.tabGroups.update(chat.groupId, { title: this.decorate(session.id) });
    } catch {}
  }

  // setWorking marks a chat's group while it acts, and unmarks it when its
  // turn ends.
  async setWorking(session, working) {
    if (working) this.working.add(session.id);
    else this.working.delete(session.id);
    await this.retitle(session);
  }

  chats() {
    return Object.entries(this.state.chats).map(([sessionId, chat]) => ({
      sessionId,
      title: chat.title,
      working: this.working.has(sessionId),
    }));
  }
}
