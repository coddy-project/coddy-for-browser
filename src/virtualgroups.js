// Tab groups where the browser has none (Firefox for Android): the calls the
// extension makes of tabs.group, tabs.ungroup and tabGroups, answered by the
// extension itself, and the group of every tab it hands out. Without a tab
// strip a group shows only where the extension draws it: the side panel's
// strip names the chat that holds a tab, and a tab Coddy works in glows. As
// the browser's own, a group lives while it has tabs and its ids last as long
// as the browser runs, so the bookkeeping is in session storage, next to the
// groups' own (groups.js).

const NONE = -1;

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    emit: (...args) => [...listeners].forEach((fn) => fn(...args)),
  };
}

// overlay answers the keys of overrides itself and everything else from
// target, so the rest of the browser's API stays as it is. The proxy stands
// over an object of its own: a property of the browser's API object that
// cannot be redefined could not be answered differently through it.
function overlay(target, overrides) {
  return new Proxy(
    {},
    {
      get(_, key) {
        if (Object.hasOwn(overrides, key)) return overrides[key];
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
      has: (_, key) => Object.hasOwn(overrides, key) || key in target,
    },
  );
}

// withVirtualGroups is api with tab groups kept in store ({get, set}).
export function withVirtualGroups(api, store) {
  let state = { next: 1, groups: {}, tabs: {} };
  const ready = (async () => {
    state = (await store.get()) || state;
  })();
  const removed = event();
  const withGroup = (tab) => tab && { ...tab, groupId: state.tabs[tab.id] ?? NONE };

  // prune drops the groups left without tabs, as the browser does, and tells
  // the listeners of tabGroups.onRemoved.
  async function prune() {
    const used = new Set(Object.values(state.tabs));
    const gone = Object.keys(state.groups).map(Number).filter((id) => !used.has(id));
    for (const id of gone) delete state.groups[id];
    await store.set(state);
    for (const id of gone) removed.emit({ id });
  }

  api.tabs.onRemoved.addListener(async (tabId) => {
    await ready;
    if (!Object.hasOwn(state.tabs, tabId)) return;
    delete state.tabs[tabId];
    await prune();
  });

  // Listeners of tabs.onUpdated get the tab with its group; removeListener
  // finds the wrapper of the listener it is given.
  const wrappers = new Map();
  const onUpdated = {
    addListener(fn) {
      const wrapper = (id, info, tab) => ready.then(() => fn(id, info, withGroup(tab)));
      wrappers.set(fn, wrapper);
      api.tabs.onUpdated.addListener(wrapper);
    },
    removeListener(fn) {
      const wrapper = wrappers.get(fn);
      if (!wrapper) return;
      wrappers.delete(fn);
      api.tabs.onUpdated.removeListener(wrapper);
    },
    hasListener: (fn) => wrappers.has(fn),
  };

  const tabs = {
    onUpdated,
    async query(queryInfo) {
      await ready;
      return (await api.tabs.query(queryInfo)).map(withGroup);
    },
    async get(tabId) {
      await ready;
      return withGroup(await api.tabs.get(tabId));
    },
    async create(props) {
      await ready;
      return withGroup(await api.tabs.create(props));
    },
    async group({ tabIds, groupId }) {
      await ready;
      if (groupId === undefined) {
        groupId = state.next++;
        state.groups[groupId] = { title: "", color: "grey" };
      } else if (!Object.hasOwn(state.groups, groupId)) throw new Error(`No group with id: ${groupId}`);
      for (const id of [].concat(tabIds)) state.tabs[id] = groupId;
      await prune();
      return groupId;
    },
    async ungroup(tabIds) {
      await ready;
      for (const id of [].concat(tabIds)) delete state.tabs[id];
      await prune();
    },
  };

  const group = (id) => {
    if (!Object.hasOwn(state.groups, id)) throw new Error(`No group with id: ${id}`);
    return state.groups[id];
  };
  const tabGroups = {
    onRemoved: removed,
    async get(id) {
      await ready;
      return { id, ...group(id) };
    },
    async update(id, { title, color } = {}) {
      await ready;
      const g = group(id);
      if (title !== undefined) g.title = String(title);
      if (color !== undefined) g.color = String(color);
      await store.set(state);
      return { id, ...g };
    },
  };

  return overlay(api, { tabs: overlay(api.tabs, tabs), tabGroups });
}
