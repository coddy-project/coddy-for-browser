// A small stand-in for the chrome.tabs / chrome.tabGroups / chrome.scripting /
// chrome.debugger surface the extension calls, enough to run its logic in
// Node. Groups behave like Chrome's: a group lives while it has tabs.

export function memoryStore(initial) {
  let value = initial;
  return { get: async () => value, set: async (v) => void (value = structuredClone(v)), peek: () => value };
}

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => [...listeners].forEach((fn) => fn(...args)),
  };
}

export function fakeChrome() {
  const tabs = new Map();
  const groups = new Map();
  let nextTab = 100;
  let nextGroup = 1;
  const calls = [];
  const prune = () => {
    for (const id of groups.keys()) if (![...tabs.values()].some((t) => t.groupId === id)) groups.delete(id);
  };
  const api = {
    calls,
    addTab(url, title = url, extra = {}) {
      const tab = { id: nextTab++, url, title, windowId: 1, groupId: -1, status: "complete", ...extra };
      tabs.set(tab.id, tab);
      return tab;
    },
    tabsById: tabs,
    groupsById: groups,
    tabs: {
      onUpdated: event(),
      async query() {
        return [...tabs.values()].map((t) => ({ ...t }));
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      async create({ url, windowId = 1 }) {
        const tab = api.addTab(url, "New tab", { windowId, status: "loading" });
        calls.push(["tabs.create", url]);
        setTimeout(() => {
          tab.status = "complete";
          tab.title = "Loaded " + url;
          api.tabs.onUpdated.emit(tab.id, { status: "complete" }, { ...tab });
        }, 5);
        return { ...tab };
      },
      async group({ tabIds, groupId, createProperties }) {
        if (groupId === undefined) {
          groupId = nextGroup++;
          groups.set(groupId, { id: groupId, title: "", color: "grey", windowId: createProperties?.windowId ?? 1 });
        } else if (!groups.has(groupId)) throw new Error(`No group with id: ${groupId}`);
        for (const id of tabIds) {
          const t = tabs.get(id);
          t.groupId = groupId;
          t.windowId = groups.get(groupId).windowId;
        }
        prune();
        calls.push(["tabs.group", tabIds, groupId]);
        return groupId;
      },
      async ungroup(tabIds) {
        for (const id of [].concat(tabIds)) tabs.get(id).groupId = -1;
        prune();
        calls.push(["tabs.ungroup", tabIds]);
      },
      async remove(id) {
        tabs.delete(id);
        prune();
        calls.push(["tabs.remove", id]);
      },
      async update(id, props) {
        Object.assign(tabs.get(id), props);
        calls.push(["tabs.update", id, props]);
      },
      async goBack(id) {
        calls.push(["tabs.goBack", id]);
      },
      async goForward(id) {
        calls.push(["tabs.goForward", id]);
      },
    },
    tabGroups: {
      async get(id) {
        const g = groups.get(id);
        if (!g) throw new Error(`No group with id: ${id}`);
        return { ...g };
      },
      async update(id, props) {
        Object.assign(groups.get(id), props);
        calls.push(["tabGroups.update", id, props]);
      },
    },
    scripting: {
      // results is what a test wants executeScript to answer per function
      // name and first argument.
      results: {},
      async executeScript({ target, func, args }) {
        calls.push(["executeScript", target.tabId, func.name, args[0]]);
        const answer = api.scripting.results[`${func.name}:${args[0]}`];
        if (answer instanceof Error) return [{ error: { message: answer.message } }];
        return [{ result: typeof answer === "function" ? answer(args[1], target.tabId) : answer ?? true }];
      },
    },
  };
  return api;
}

// fakeDebugger records CDP commands instead of sending them.
export function fakeDebugger(frameURL = () => "https://example.com/") {
  const sent = [];
  return {
    sent,
    async send(tabId, method, params, expected) {
      if (expected && new URL(frameURL(tabId)).origin !== expected.origin)
        throw Object.assign(new Error("The page changed"), { reason: "page_changed" });
      sent.push([tabId, method, params]);
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgo=" };
      if (method === "Page.getNavigationHistory")
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: "https://back.example.net/" },
            { id: 2, url: frameURL(tabId) },
            { id: 3, url: "https://forward.example.org/" },
          ],
        };
      return {};
    },
    async detachAll() {},
  };
}
