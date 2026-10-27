import test from "node:test";
import assert from "node:assert/strict";
import { Groups, SHARED_TITLE, chatTitle } from "../src/groups.js";
import { fakeChrome, memoryStore } from "./fake-chrome.mjs";

async function setup() {
  const api = fakeChrome();
  const store = memoryStore();
  const groups = new Groups(api, store);
  await groups.load();
  return { api, store, groups };
}

test("a shared tab is in the Coddy group and reported without a chat", async () => {
  const { api, groups } = await setup();
  const tab = api.addTab("https://example.com/", "Example");
  api.addTab("https://unshared.example/", "Not shared");
  api.addTab("chrome://settings", "Settings");
  await groups.share(tab.id);
  const g = api.groupsById.get(api.tabsById.get(tab.id).groupId);
  assert.equal(g.title, SHARED_TITLE);
  assert.deepEqual(await groups.tabs(), [{ id: tab.id, url: "https://example.com/", title: "Example" }]);
  await assert.rejects(groups.share(api.addTab("chrome://extensions").id), /web pages/);
});

test("a chat takes a shared tab into a group of its own, which no other chat reaches", async () => {
  const { api, groups } = await setup();
  const tab = api.addTab("https://example.com/", "Example");
  await groups.share(tab.id);
  await groups.claim(tab.id, { id: "sess_a", title: "Fix the docs" });
  const [listed] = await groups.tabs();
  assert.equal(listed.sessionId, "sess_a");
  const g = api.groupsById.get(api.tabsById.get(tab.id).groupId);
  assert.equal(g.title, "Fix the docs");
  // The shared group emptied and closed, as Chrome's do.
  assert.equal(groups.state.shared, null);
  await assert.rejects(groups.claim(tab.id, { id: "sess_b" }), (e) => e.reason === "other_chat");
  await assert.rejects(groups.claim(api.addTab("https://x.example/").id, { id: "sess_a" }), (e) => e.reason === "not_shared");
  // Its own tab stays its own.
  await groups.claim(tab.id, { id: "sess_a", title: "Fix the docs" });
});

test("a tab a chat opens starts in its group, and release hands its tabs back", async () => {
  const { api, groups } = await setup();
  const tab = await groups.open("https://example.org/", { id: "sess_a" });
  assert.equal(groups.ownerOf(api.tabsById.get(tab.id)), "sess_a");
  assert.equal(api.groupsById.get(api.tabsById.get(tab.id).groupId).title, chatTitle({ id: "sess_a" }));
  const second = await groups.open("https://example.org/2", { id: "sess_a" });
  assert.equal(api.tabsById.get(second.id).groupId, api.tabsById.get(tab.id).groupId);
  assert.equal((await groups.release("sess_a")).length, 2);
  for (const t of await groups.tabs()) assert.equal(t.sessionId, undefined);
  assert.equal(api.groupsById.get(api.tabsById.get(tab.id).groupId).title, SHARED_TITLE);
});

test("the working mark follows the chat's turn", async () => {
  const { api, groups } = await setup();
  const tab = await groups.open("https://example.org/", { id: "sess_a", title: "Report" });
  const groupId = api.tabsById.get(tab.id).groupId;
  await groups.setWorking({ id: "sess_a" }, true);
  assert.match(api.groupsById.get(groupId).title, /^⏳ Report$/);
  await groups.setWorking({ id: "sess_a" }, false);
  assert.equal(api.groupsById.get(groupId).title, "Report");
});

test("Stop ungroups every Coddy tab and forgets the groups", async () => {
  const { api, groups, store } = await setup();
  const shared = api.addTab("https://example.com/");
  await groups.share(shared.id);
  await groups.open("https://example.org/", { id: "sess_a" });
  const mine = api.addTab("https://mine.example/");
  await api.tabs.group({ tabIds: [mine.id] });
  await groups.stopAll();
  assert.deepEqual(await groups.tabs(), []);
  assert.deepEqual(store.peek(), { shared: null, chats: {} });
  // A group the user made is not Coddy's to dissolve.
  assert.notEqual(api.tabsById.get(mine.id).groupId, -1);
});

test("groups the user closed are forgotten, and the bookkeeping survives a reload", async () => {
  const { api, groups, store } = await setup();
  const tab = await groups.open("https://example.org/", { id: "sess_a" });
  const again = new Groups(api, store);
  await again.load();
  assert.equal(again.ownerOf(api.tabsById.get(tab.id)), "sess_a");
  await api.tabs.remove(tab.id);
  assert.deepEqual(await again.tabs(), []);
  assert.deepEqual(again.state.chats, {});
});

test("a long chat title is shortened and a missing one falls back to the id", () => {
  assert.equal(chatTitle({ id: "sess_0123456789", title: "x".repeat(40) }).length, 30);
  assert.equal(chatTitle({ id: "sess_0123456789" }), "Coddy 456789");
});

test("a chat of another Coddy keeps its machine in the group's title, however long its own", () => {
  const title = chatTitle({ id: "laptop/sess_1", title: "x".repeat(40), node: "laptop" });
  assert.ok(title.endsWith(" (laptop)"), title);
  assert.ok(title.length <= 30, title);
});

test("changes of the groups run one at a time, so Stop catches a tab being opened", async () => {
  const { api, groups } = await setup();
  const opening = groups.open("https://example.org/", { id: "sess_a" });
  const stopping = groups.stopAll();
  const tab = await opening;
  await stopping;
  assert.equal(api.tabsById.get(tab.id).groupId, -1);
  assert.deepEqual(groups.state.chats, {});
});

test("the tab the person writes from goes into the panel chat's group, from any group", async () => {
  const { api, groups } = await setup();
  const tab = api.addTab("https://example.com/", "Example");
  await groups.open("https://other.example/", { id: "sess_other" });
  await api.tabs.group({ tabIds: [tab.id], groupId: groups.state.chats.sess_other.groupId });
  await groups.adopt(tab.id, { id: "sess_panel", title: "Panel chat" });
  assert.equal(groups.ownerOf(api.tabsById.get(tab.id)), "sess_panel");
  await groups.adopt(tab.id, { id: "sess_panel" });
  assert.equal(groups.ownerOf(api.tabsById.get(tab.id)), "sess_panel");
  await assert.rejects(groups.adopt(api.addTab("chrome://settings").id, { id: "sess_panel" }), /web pages/);
});
