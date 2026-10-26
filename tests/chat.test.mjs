import test from "node:test";
import assert from "node:assert/strict";
import { ChatBridge } from "../src/chat.js";
import { Peer } from "../src/rpc.js";

// fakePort plays one side panel.
function fakePort() {
  const listeners = { message: [], disconnect: [] };
  return {
    sent: [],
    postMessage(msg) {
      this.sent.push(msg);
    },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    say: (msg) => Promise.all(listeners.message.map((fn) => fn(msg))),
    close: () => listeners.disconnect.forEach((fn) => fn()),
  };
}

function bridge() {
  const toCoddy = [];
  const peer = new Peer((text) => toCoddy.push(JSON.parse(text)));
  const adopted = [];
  const chat = new ChatBridge({
    connection: { connected: () => true, peer },
    groups: { adopt: async (id, session) => (adopted.push([id, session.id]), { id, url: "https://example.com/", title: "Example" }) },
    publish: async () => {},
  });
  chat.setup(peer);
  return { chat, peer, toCoddy, adopted };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a send gives the tab to the chat before the turn and streams to the panel showing it", async () => {
  const { chat, peer, toCoddy, adopted } = bridge();
  const port = fakePort();
  chat.attach(port);
  const sending = port.say({ type: "send", id: 1, sessionId: "sess_a", text: "read this page", tabId: 7 });
  await tick();
  assert.deepEqual(adopted, [[7, "sess_a"]]);
  const req = toCoddy.find((m) => m.method === "chat/send");
  assert.deepEqual(req.params, { sessionId: "sess_a", text: "read this page", tab: { id: 7, url: "https://example.com/", title: "Example" } });
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "chat/update", params: { sessionId: "sess_a", kind: "text", text: "Hi" } }));
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "chat/update", params: { sessionId: "sess_b", kind: "text", text: "not here" } }));
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } }));
  await sending;
  assert.deepEqual(port.sent.filter((m) => m.type === "update").map((m) => m.update.text), ["Hi"]);
  assert.deepEqual(port.sent.at(-1), { type: "reply", id: 1, value: { stopReason: "end_turn" }, error: undefined });
});

test("a permission Coddy asks is shown in the chat's panel and answered from it", async () => {
  const { chat, peer, toCoddy } = bridge();
  const port = fakePort();
  chat.attach(port);
  await port.say({ type: "watch", id: 1, sessionId: "sess_a" });
  const asking = peer.receive(
    JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "chat/permission", params: { sessionId: "sess_a", title: "browser", options: [{ optionId: "allow", kind: "allow_once" }] } }),
  );
  await tick();
  const shown = port.sent.find((m) => m.type === "permission");
  assert.equal(shown.title, "browser");
  await port.say({ type: "answer", id: 2, requestId: shown.requestId, value: { optionId: "allow" } });
  await asking;
  assert.deepEqual(toCoddy.at(-1), { jsonrpc: "2.0", id: "p1", result: { optionId: "allow" } });
  assert.ok(port.sent.some((m) => m.type === "settled" && m.requestId === shown.requestId));
});

test("a question with no panel, or whose panel closes, is refused", async () => {
  const { chat, peer, toCoddy } = bridge();
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "q1", method: "chat/question", params: { sessionId: "sess_a", questions: [] } }));
  assert.equal(toCoddy.at(-1).error.code, -32000);
  const port = fakePort();
  chat.attach(port);
  await port.say({ type: "watch", id: 1, sessionId: "sess_a" });
  const asking = peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "q2", method: "chat/question", params: { sessionId: "sess_a", questions: [] } }));
  await tick();
  port.close();
  await asking;
  assert.match(toCoddy.at(-1).error.message, /closed/);
});

test("new, list, messages and cancel go to Coddy as they are", async () => {
  const { chat, peer, toCoddy } = bridge();
  const port = fakePort();
  chat.attach(port);
  const creating = port.say({ type: "new", id: 1 });
  await tick();
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: toCoddy.at(-1).id, result: { sessionId: "sess_new" } }));
  await creating;
  assert.equal(chat.watching.get(port), "sess_new");
  await port.say({ type: "cancel", id: 2, sessionId: "sess_new" });
  assert.deepEqual(toCoddy.at(-1), { jsonrpc: "2.0", method: "chat/cancel", params: { sessionId: "sess_new" } });
  const failed = { connected: () => false };
  chat.connection = failed;
  await port.say({ type: "list", id: 3 });
  assert.equal(port.sent.at(-1).error, "Not connected to Coddy");
});
