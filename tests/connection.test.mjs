import test from "node:test";
import assert from "node:assert/strict";
import { Connection, backoff, PROTOCOL_VERSION } from "../src/connection.js";

// FakeSocket plays Coddy's side of one WebSocket.
class FakeSocket {
  static last;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
    this.onsent?.(JSON.parse(text));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.(), 0);
  }
  deliver(msg) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
  }
}

const settings = { address: "http://127.0.0.1:12348", key: "k".repeat(32), id: "browser-id-0001", name: "Chrome", enabled: true };
const tick = () => new Promise((r) => setTimeout(r, 5));

function connection(over = {}) {
  const statuses = [];
  const c = new Connection({
    WebSocket: FakeSocket,
    settings: () => ({ ...settings, ...over }),
    version: "0.1.0",
    actions: ["snapshot"],
    grant: () => "grant-1",
    onStatus: (s) => statuses.push(s),
    ...over.opts,
  });
  return { c, statuses };
}

test("initialize goes first with the key, the browser, its actions and its grant", async () => {
  let ready = false;
  const { c } = connection({ opts: { onReady: () => (ready = true) } });
  c.connect();
  await tick();
  const ws = FakeSocket.last;
  assert.equal(ws.url, "ws://127.0.0.1:12348/browser/v1/connect");
  const [hello] = ws.sent;
  assert.equal(hello.method, "initialize");
  assert.deepEqual(hello.params, {
    protocolVersion: PROTOCOL_VERSION,
    key: settings.key,
    browser: { id: "browser-id-0001", name: "Chrome", version: "0.1.0" },
    actions: ["snapshot"],
    grant: "grant-1",
  });
  ws.deliver({ id: hello.id, result: { protocolVersion: 1, server: { name: "coddy", version: "1.4.0" } } });
  await tick();
  assert.equal(c.status, "Connected");
  assert.ok(ready);
  assert.equal(c.server.version, "1.4.0");
  c.close();
});

test("a refused key is final: no reconnect loop", async () => {
  const { c } = connection();
  c.connect();
  await tick();
  const ws = FakeSocket.last;
  ws.deliver({ id: ws.sent[0].id, error: { code: -32001, message: "invalid extension key" } });
  await tick();
  await tick();
  assert.equal(c.status, "Coddy refused the extension key");
  assert.equal(c.timers.length, 0);
});

test("a lost socket is dialled again after a backoff", async () => {
  const { c } = connection();
  c.connect();
  await tick();
  const first = FakeSocket.last;
  first.deliver({ id: first.sent[0].id, result: { protocolVersion: 1 } });
  await tick();
  first.close();
  await tick();
  assert.match(c.status, /retrying in/);
  assert.equal(c.timers.length, 1);
  c.close();
});

test("handlers registered in setup answer Coddy's requests", async () => {
  const { c } = connection({
    opts: { setup: (peer) => peer.onRequest("browser/command", (p) => ({ echoed: p.action })) },
  });
  c.connect();
  await tick();
  const ws = FakeSocket.last;
  ws.deliver({ id: ws.sent[0].id, result: { protocolVersion: 1 } });
  await tick();
  ws.deliver({ id: "abc", method: "browser/command", params: { action: "snapshot" } });
  await tick();
  assert.deepEqual(ws.sent.at(-1), { jsonrpc: "2.0", id: "abc", result: { echoed: "snapshot" } });
  c.close();
});

test("an invalid address or a missing key never dials", () => {
  const { c } = connection({ address: "http://10.0.0.5:12348" });
  FakeSocket.last = null;
  c.connect();
  assert.equal(FakeSocket.last, null);
  assert.match(c.status, /HTTPS/);
  const { c: noKey } = connection({ key: "" });
  noKey.connect();
  assert.equal(FakeSocket.last, null);
  assert.match(noKey.status, /key/);
  const { c: off } = connection({ enabled: false });
  off.connect();
  assert.equal(FakeSocket.last, null);
});

test("backoff grows to a minute with jitter", () => {
  assert.equal(backoff(0, () => 0.5), 1000);
  assert.equal(backoff(2, () => 0.5), 2250);
  assert.equal(backoff(50, () => 0.5), 60000);
  assert.ok(backoff(0, () => 0) >= 800 && backoff(0, () => 1) <= 1200);
});
