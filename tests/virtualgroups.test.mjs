import test from "node:test";
import assert from "node:assert/strict";
import { withVirtualGroups } from "../src/virtualgroups.js";
import { Groups, GROUP_TITLE } from "../src/groups.js";
import { Commands } from "../src/commands.js";
import { Approvals } from "../src/approvals.js";
import { pageInput } from "../src/pageinput.js";
import { fakeAndroid, memoryStore } from "./fake-chrome.mjs";

async function setup(store = memoryStore()) {
  const android = fakeAndroid();
  const api = withVirtualGroups(android, store);
  const groups = new Groups(api, memoryStore());
  await groups.load();
  return { android, api, groups, store };
}

test("Firefox for Android has no tab groups, so the extension keeps them, and a chat still holds its tabs alone", async () => {
  const { android, groups } = await setup();
  const tab = android.addTab("https://example.com/", "Example");
  android.addTab("https://unshared.example/", "Not shared");
  await groups.share(tab.id);
  assert.deepEqual(await groups.tabs(), [{ id: tab.id, url: "https://example.com/", title: "Example" }]);

  await groups.claim(tab.id, { id: "sess_a", title: "Fix the docs" });
  assert.deepEqual(await groups.tabs(), [{ id: tab.id, url: "https://example.com/", title: "Example", sessionId: "sess_a" }]);
  await assert.rejects(groups.claim(tab.id, { id: "sess_b" }), (e) => e.reason === "other_chat");
  assert.equal(groups.chats()[0].title, "Fix the docs");

  const opened = await groups.open("https://example.org/", { id: "sess_a" });
  assert.equal((await groups.tabs()).find((t) => t.id === opened.id).sessionId, "sess_a");
  assert.deepEqual((await groups.release("sess_a")).sort(), [tab.id, opened.id].sort());
  assert.ok((await groups.tabs()).every((t) => !t.sessionId));

  await groups.unshare(tab.id);
  assert.deepEqual((await groups.tabs()).map((t) => t.id), [opened.id]);
  await groups.stopAll();
  assert.deepEqual(await groups.tabs(), []);
});

test("a group the person closed the last tab of is gone, and the groups outlive a reload of the background", async () => {
  const store = memoryStore();
  const { android, api, groups } = await setup(store);
  const removed = [];
  api.tabGroups.onRemoved.addListener((g) => removed.push(g.id));
  const tab = android.addTab("https://example.com/");
  await groups.adopt(tab.id, { id: "sess_a", title: "Chat" });
  const groupId = groups.state.chats.sess_a.groupId;
  assert.equal((await api.tabGroups.get(groupId)).title, GROUP_TITLE);
  assert.equal((await api.tabs.get(tab.id)).groupId, groupId);

  // A background loaded again reads the same groups from session storage.
  const again = withVirtualGroups(android, store);
  assert.equal((await again.tabs.get(tab.id)).groupId, groupId);

  await android.tabs.remove(tab.id);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(removed, [groupId]);
  await assert.rejects(api.tabGroups.get(groupId), /No group/);
});

test("a tab update reaches its listeners with the tab's group, and a removed listener hears nothing", async () => {
  const { android, api, groups } = await setup();
  const tab = android.addTab("https://example.com/");
  await groups.share(tab.id);
  const seen = [];
  const listener = (id, info, t) => seen.push(t.groupId);
  api.tabs.onUpdated.addListener(listener);
  android.tabs.onUpdated.emit(tab.id, { title: "x" }, android.tabsById.get(tab.id));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, [groups.state.shared]);
  api.tabs.onUpdated.removeListener(listener);
  android.tabs.onUpdated.emit(tab.id, { title: "y" }, android.tabsById.get(tab.id));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.length, 1);
});

test("a command on Firefox for Android takes a shared tab into the chat's group and acts through the page", async () => {
  const { android, api, groups } = await setup();
  const approvals = new Approvals({ store: memoryStore({ always: ["https://example.com"], chats: {} }), timeoutMs: 40 });
  await approvals.load();
  const commands = new Commands({
    api,
    groups,
    approvals,
    settings: () => ({ address: "http://127.0.0.1:12348", key: "k".repeat(32) }),
    grant: () => "g1",
    publish: async () => {},
  });
  commands.input = pageInput(api, (tabId, action, params) => commands.script(tabId, action, params));
  android.scripting.results["pageAction:snapshot"] = { title: "Example", text: "Hello", elements: [] };
  const tab = android.addTab("https://example.com/", "Example");
  await groups.share(tab.id);
  const session = { id: "sess_a", title: "Chat A" };
  const result = await commands.handle({ action: "snapshot", tabId: tab.id, params: {}, grant: "g1", session });
  assert.equal(result.text, "Hello");
  assert.equal(groups.ownerOf(await api.tabs.get(tab.id)), "sess_a");
  await assert.rejects(
    commands.handle({ action: "snapshot", tabId: tab.id, params: {}, grant: "g1", session: { id: "sess_b" } }),
    (e) => e.reason === "other_chat",
  );
});
