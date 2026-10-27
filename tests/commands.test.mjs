import test from "node:test";
import assert from "node:assert/strict";
import { Commands } from "../src/commands.js";
import { Groups } from "../src/groups.js";
import { Approvals } from "../src/approvals.js";
import { cdpInput } from "../src/input.js";
import { pageInput } from "../src/pageinput.js";
import { fakeChrome, fakeDebugger, memoryStore } from "./fake-chrome.mjs";

async function setup({ allow = ["https://example.com", "https://example.org"] } = {}) {
  const api = fakeChrome();
  const groups = new Groups(api, memoryStore());
  await groups.load();
  const approvals = new Approvals({ store: memoryStore({ always: allow, chats: {} }), timeoutMs: 40 });
  await approvals.load();
  const dbg = fakeDebugger((tabId) => api.tabsById.get(tabId)?.url || "about:blank");
  let published = 0;
  const fetches = [];
  const grant = { value: "g1" };
  const commands = new Commands({
    api,
    groups,
    approvals,
    input: cdpInput(dbg),
    settings: () => ({ address: "http://127.0.0.1:12348", key: "k".repeat(32) }),
    grant: () => grant.value,
    publish: async () => void published++,
    fetch: async (url, init = {}) => {
      fetches.push([url, init]);
      if (url.includes("/browser/v1/files/") && (init.method || "GET") === "GET")
        return new Response(new Uint8Array([104, 105]));
      if (url.includes("/browser/v1/files/")) return new Response(null, { status: 204 });
      return new Response("downloaded");
    },
  });
  api.scripting.results["pageAction:snapshot"] = { title: "Example", text: "Hello", elements: [{ ref: "n:1", x: 10, y: 20 }] };
  api.scripting.results["pageAction:target"] = { x: 50, y: 60 };
  api.scripting.results["pageAction:viewport"] = { width: 800, height: 600, scale: 2 };
  api.scripting.results["pageAction:upload_file"] = (p) => ({ filename: p.filename, bytes: atob(p.base64).length });
  return { api, groups, approvals, dbg, commands, grant, fetches, published: () => published };
}

const chat = { id: "sess_a", title: "Chat A" };
const cmd = (action, tabId, params = {}, session = chat, grant = "g1") => ({ action, tabId, params, grant, session });

test("a snapshot of a shared tab takes the tab into the chat's group and reads the page", async () => {
  const { api, groups, commands, published } = await setup();
  const tab = api.addTab("https://example.com/", "Example");
  await groups.share(tab.id);
  const result = await commands.handle(cmd("snapshot", tab.id));
  assert.equal(result.text, "Hello");
  assert.deepEqual(result.tab, { id: tab.id, url: "https://example.com/", title: "Example" });
  assert.equal(groups.ownerOf(api.tabsById.get(tab.id)), "sess_a");
  assert.ok(published() >= 1);
  // The page saw the origin the action was approved for.
  const call = api.calls.find((c) => c[0] === "executeScript" && c[3] === "snapshot");
  assert.ok(call);
});

test("a command of a stale selection, of another chat, or for an unshared tab is refused", async () => {
  const { api, groups, commands } = await setup();
  const tab = api.addTab("https://example.com/");
  await groups.share(tab.id);
  await assert.rejects(commands.handle(cmd("snapshot", tab.id, {}, chat, "old")), (e) => e.reason === "stopped");
  await commands.handle(cmd("snapshot", tab.id));
  await assert.rejects(commands.handle(cmd("click", tab.id, { x: 1, y: 1 }, { id: "sess_b" })), (e) => e.reason === "other_chat");
  const loose = api.addTab("https://example.com/other");
  await assert.rejects(commands.handle(cmd("snapshot", loose.id)), (e) => e.reason === "not_shared");
  await assert.rejects(commands.handle(cmd("snapshot", 9999)), (e) => e.reason === "not_shared");
  await assert.rejects(commands.handle(cmd("evaluate", tab.id)), (e) => e.reason === "unsupported");
  await assert.rejects(commands.handle({ action: "snapshot", tabId: tab.id, grant: "g1", session: {} }), (e) => e.reason === "invalid_params");
});

test("a site the user did not allow is asked about first", async () => {
  const { api, groups, commands, approvals } = await setup({ allow: [] });
  const tab = api.addTab("https://example.com/");
  await groups.share(tab.id);
  const pending = commands.handle(cmd("snapshot", tab.id));
  await new Promise((r) => setTimeout(r, 5));
  const [q] = approvals.list();
  assert.equal(q.origin, "https://example.com");
  await approvals.decide(q.id, "chat");
  assert.equal((await pending).text, "Hello");
});

test("open_tab opens the tab in the chat's group and names it once Coddy knows it", async () => {
  const { api, groups, commands, published } = await setup();
  const result = await commands.handle(cmd("open_tab", 0, { url: "https://example.org/start" }));
  assert.equal(result.url, "https://example.org/start");
  assert.equal(groups.ownerOf(api.tabsById.get(result.tabId)), "sess_a");
  assert.ok(published() >= 1);
  await assert.rejects(commands.handle(cmd("open_tab", 0, { url: "file:///etc/passwd" })));
});

test("clicks by ref go through the element's centre as trusted input", async () => {
  const { api, groups, commands, dbg } = await setup();
  const tab = await groups.open("https://example.com/", chat);
  api.tabsById.get(tab.id).status = "complete";
  await commands.handle(cmd("click", tab.id, { ref: "n:1" }));
  const presses = dbg.sent.filter(([, m, p]) => m === "Input.dispatchMouseEvent" && p.type === "mousePressed");
  assert.deepEqual([presses[0][2].x, presses[0][2].y], [50, 60]);
  await commands.handle(cmd("click", tab.id, { x: 5, y: 6, count: 2 }));
  assert.equal(dbg.sent.filter(([, m, p]) => m === "Input.dispatchMouseEvent" && p.type === "mousePressed").length, 3);
  await assert.rejects(commands.handle(cmd("click", tab.id, {})), (e) => e.reason === "invalid_params");
  await commands.handle(cmd("type", tab.id, { ref: "n:1", text: "hi", clear: true }));
  assert.ok(dbg.sent.some(([, m, p]) => m === "Input.insertText" && p.text === "hi"));
  await commands.handle(cmd("scroll", tab.id, { dy: 300 }));
  const wheel = dbg.sent.find(([, m, p]) => m === "Input.dispatchMouseEvent" && p.type === "mouseWheel");
  assert.deepEqual([wheel[2].x, wheel[2].y, wheel[2].deltaY], [400, 300, 300]);
});

test("a screenshot is taken at one image pixel per CSS pixel with the indicator hidden", async () => {
  const { api, groups, commands, dbg } = await setup();
  const tab = await groups.open("https://example.com/", chat);
  const result = await commands.handle(cmd("screenshot", tab.id));
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  const shot = dbg.sent.find(([, m]) => m === "Page.captureScreenshot");
  assert.equal(shot[2].clip.scale, 0.5);
  const marks = api.calls.filter((c) => c[0] === "executeScript" && c[2] === "indicator").map((c) => c[3]);
  assert.deepEqual(marks.slice(-2), [false, true]);
});

test("files move through the listener's one-time tickets with the key", async () => {
  const { groups, commands, fetches } = await setup();
  const tab = await groups.open("https://example.com/", chat);
  const ticket = "a".repeat(48);
  const up = await commands.handle(cmd("upload_file", tab.id, { ref: "n:1", transfer_id: ticket, filename: "x.txt" }));
  assert.deepEqual([up.filename, up.bytes], ["x.txt", 2]);
  assert.equal(fetches[0][0], "http://127.0.0.1:12348/browser/v1/files/" + ticket);
  assert.equal(fetches[0][1].headers.Authorization, "Bearer " + "k".repeat(32));
  const down = await commands.handle(cmd("download_file", tab.id, { url: "/file.bin", transfer_id: ticket, filename: "f" }));
  assert.equal(down.bytes, 10);
  assert.equal(fetches[1][0], "https://example.com/file.bin");
  assert.equal(fetches[1][1].redirect, "error");
  assert.equal(fetches[2][1].method, "POST");
  await assert.rejects(commands.handle(cmd("upload_file", tab.id, { ref: "n:1", transfer_id: "../x" })));
});

test("navigate to another site asks about that site too, back and forward included", async () => {
  const { api, groups, commands, approvals, dbg } = await setup({ allow: ["https://example.com"] });
  const tab = await groups.open("https://example.com/", chat);
  const going = commands.handle(cmd("navigate", tab.id, { url: "https://other.example/" }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(approvals.list()[0].origin, "https://other.example");
  await approvals.decide(approvals.list()[0].id, "deny");
  await assert.rejects(going, (e) => e.reason === "site_declined");
  assert.equal(api.tabsById.get(tab.id).url, "https://example.com/");
  // The page back is on another site: the question comes first, then the
  // step through the debugger.
  const send = dbg.send;
  dbg.send = async (tabId, method, params, expected) => {
    const r = await send(tabId, method, params, expected);
    if (method === "Page.navigateToHistoryEntry") {
      const t = api.tabsById.get(tabId);
      t.url = "https://back.example.net/";
      api.tabs.onUpdated.emit(tabId, { status: "complete" }, { ...t });
    }
    return r;
  };
  const back = commands.handle(cmd("navigate", tab.id, { url: "back" }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(approvals.list()[0].origin, "https://back.example.net");
  await approvals.decide(approvals.list()[0].id, "chat");
  assert.equal((await back).url, "https://back.example.net/");
  assert.ok(dbg.sent.some(([, m, p]) => m === "Page.navigateToHistoryEntry" && p.entryId === 1));
});

test("Stop reaches a tab being opened: it ends outside every group and the command fails", async () => {
  const { api, groups, commands, grant } = await setup();
  const opening = commands.handle(cmd("open_tab", 0, { url: "https://example.org/" }));
  await new Promise((r) => setTimeout(r, 0));
  grant.value = "g2";
  await groups.stopAll();
  await assert.rejects(opening, (e) => e.reason === "stopped");
  for (const tab of api.tabsById.values()) assert.equal(tab.groupId, -1);
});

test("a tab taken back while its question waited is not navigated", async () => {
  const { api, groups, commands, approvals } = await setup({ allow: ["https://example.com"] });
  const tab = await groups.open("https://example.com/", chat);
  const going = commands.handle(cmd("navigate", tab.id, { url: "https://bank.example.net/" }));
  await new Promise((r) => setTimeout(r, 5));
  await groups.unshare(tab.id);
  await approvals.decide(approvals.list()[0].id, "chat");
  await assert.rejects(going, (e) => e.reason === "page_changed");
  assert.equal(api.tabsById.get(tab.id).url, "https://example.com/");
});

test("a declined site hands a shared tab back to the shared group", async () => {
  const { api, groups, commands, approvals } = await setup({ allow: [] });
  const tab = api.addTab("https://example.com/");
  await groups.share(tab.id);
  const asking = commands.handle(cmd("snapshot", tab.id));
  await new Promise((r) => setTimeout(r, 5));
  await approvals.decide(approvals.list()[0].id, "deny");
  await assert.rejects(asking, (e) => e.reason === "site_declined");
  assert.equal(groups.ownerOf(api.tabsById.get(tab.id)), "");
});

test("input aimed at a frame of another website is refused", async () => {
  const { api, groups, commands, dbg } = await setup();
  const tab = api.addTab("https://example.com/");
  await groups.share(tab.id);
  api.scripting.results["pageAction:hit"] = { crossOrigin: true };
  await assert.rejects(commands.handle(cmd("click", tab.id, { x: 10, y: 10 })), (e) => e.reason === "cross_origin_frame");
  assert.ok(!dbg.sent.some(([, m]) => m === "Input.dispatchMouseEvent"));
});

test("without the debugger, input and screenshots go through the page", async () => {
  const { api, groups, commands } = await setup();
  const captured = [];
  api.tabs.captureTab = async (tabId, opts) => (captured.push([tabId, opts]), "data:image/png;base64,iVBORw0KGgo=");
  commands.input = pageInput(api, (tabId, action, params) => commands.script(tabId, action, params));
  api.scripting.results["pageAction:input"] = (p) => ({ ok: true, trusted: false, kind: p.kind, origin: p.expected_origin });
  const tab = api.addTab("https://example.com/");
  await groups.share(tab.id);
  const clicked = await commands.handle(cmd("click", tab.id, { x: 5, y: 6 }));
  assert.equal(clicked.kind, "click");
  assert.equal(clicked.trusted, false);
  assert.equal(clicked.origin, "https://example.com");
  const shot = await commands.handle(cmd("screenshot", tab.id));
  assert.match(shot.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(captured, [[tab.id, { format: "png", scale: 0.5 }]]);
});

test("release takes the working marks off the tabs it hands back", async () => {
  const { api, groups, commands } = await setup();
  const tab = await groups.open("https://example.com/", chat);
  await commands.handle(cmd("snapshot", tab.id));
  api.calls.length = 0;
  await commands.handle(cmd("release", 0));
  assert.ok(api.calls.some((c) => c[0] === "executeScript" && c[1] === tab.id && c[2] === "indicator" && c[3] === false));
});

test("release and close_tab act on the chat's own tabs", async () => {
  const { api, groups, commands } = await setup();
  const one = await groups.open("https://example.com/", chat);
  await groups.open("https://example.org/", chat);
  assert.deepEqual(await commands.handle(cmd("close_tab", one.id)), { closed: true });
  assert.ok(!api.tabsById.has(one.id));
  assert.deepEqual(await commands.handle(cmd("release", 0)), { released: 1 });
  for (const t of await groups.tabs()) assert.equal(t.sessionId, undefined);
});

test("a chat of another Coddy is asked about once, and an always-allowed site still asks for it", async () => {
  const { api, groups, commands, approvals } = await setup();
  const tab = api.addTab("https://example.com/");
  await groups.share(tab.id);
  const remote = { id: "laptop/sess_r", title: "Trip", node: "laptop" };
  const first = commands.handle(cmd("snapshot", tab.id, {}, remote));
  await new Promise((r) => setTimeout(r, 5));
  let [q] = approvals.list();
  assert.equal(q.kind, "chat");
  assert.deepEqual(q.session, { id: "laptop/sess_r", title: "Trip", node: "laptop" });
  await approvals.decide(q.id, "chat");
  // example.com is always allowed, but not for a chat of another Coddy.
  await new Promise((r) => setTimeout(r, 5));
  [q] = approvals.list();
  assert.equal(q.kind, "site");
  assert.equal(q.origin, "https://example.com");
  await approvals.decide(q.id, "always");
  const result = await first;
  assert.equal(result.text, "Hello");
  assert.equal(groups.ownerOf(api.tabsById.get(tab.id)), "laptop/sess_r");
  // Allowed for that chat only: the next action asks nothing, and the
  // "always" it chose did not become one for every chat.
  await commands.handle(cmd("snapshot", tab.id, {}, remote));
  assert.equal(approvals.list().length, 0);
  assert.ok(!approvals.allowed("https://example.com", { id: "laptop/sess_other", node: "laptop" }));
});

test("a declined chat of another Coddy reaches nothing, and Stop takes its approval back", async () => {
  const { api, groups, commands, approvals } = await setup();
  const tab = api.addTab("https://example.com/");
  await groups.share(tab.id);
  const remote = { id: "laptop/sess_d", title: "Mail", node: "laptop" };
  const declined = commands.handle(cmd("snapshot", tab.id, {}, remote));
  await new Promise((r) => setTimeout(r, 5));
  await approvals.decide(approvals.list()[0].id, "deny");
  await assert.rejects(declined, (e) => e.reason === "chat_declined");
  const asked = approvals.ensureChat({ id: "laptop/sess_ok", node: "laptop" });
  await approvals.decide(approvals.list()[0].id, "chat");
  await asked;
  assert.ok(approvals.chatAllowed({ id: "laptop/sess_ok", node: "laptop" }));
  await approvals.forgetRemote();
  assert.ok(!approvals.chatAllowed({ id: "laptop/sess_ok", node: "laptop" }));
  // A chat of the connected server never asks.
  assert.ok(approvals.chatAllowed({ id: "sess_local" }));
});
