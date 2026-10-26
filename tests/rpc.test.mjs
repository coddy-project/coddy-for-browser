import test from "node:test";
import assert from "node:assert/strict";
import { Peer, RPCError, codes, failure } from "../src/rpc.js";

function pair() {
  const sent = [];
  const peer = new Peer((text) => sent.push(JSON.parse(text)));
  return { peer, sent };
}

test("a request resolves with the result of the response that names it", async () => {
  const { peer, sent } = pair();
  const pending = peer.request("initialize", { key: "k" });
  assert.equal(sent[0].method, "initialize");
  assert.equal(sent[0].jsonrpc, "2.0");
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { wrong: true } }));
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: { protocolVersion: 1 } }));
  assert.deepEqual(await pending, { protocolVersion: 1 });
});

test("an error response rejects with its code and data", async () => {
  const { peer, sent } = pair();
  const pending = peer.request("initialize");
  await peer.receive(
    JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, error: { code: -32002, message: "version", data: { supported: [1] } } }),
  );
  await assert.rejects(pending, (e) => e instanceof RPCError && e.code === codes.protocolVersion && e.data.supported[0] === 1);
});

test("a request of the other side is answered with the handler's result or error", async () => {
  const { peer, sent } = pair();
  peer.onRequest("browser/command", async (params) => {
    if (params.action === "boom") throw failure("site_declined", "declined");
    return { ok: params.action };
  });
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "a1", method: "browser/command", params: { action: "click" } }));
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "a2", method: "browser/command", params: { action: "boom" } }));
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "a3", method: "nope" }));
  assert.deepEqual(sent[0], { jsonrpc: "2.0", id: "a1", result: { ok: "click" } });
  assert.deepEqual(sent[1], {
    jsonrpc: "2.0",
    id: "a2",
    error: { code: codes.failed, message: "declined", data: { reason: "site_declined" } },
  });
  assert.equal(sent[2].error.code, codes.methodNotFound);
});

test("cancel aborts the handler of a running request", async () => {
  const { peer, sent } = pair();
  let aborted = false;
  peer.onRequest("browser/command", (_, { signal }) => {
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(failure("cancelled", "cancelled"));
      }),
    );
  });
  const running = peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "x", method: "browser/command", params: {} }));
  peer.cancel("x");
  await running;
  assert.ok(aborted);
  assert.equal(sent[0].error.data.reason, "cancelled");
});

test("notifications reach their handler and close fails what is waiting", async () => {
  const { peer } = pair();
  const seen = [];
  peer.onNotification("browser/turnEnded", (p) => seen.push(p.sessionId));
  await peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "browser/turnEnded", params: { sessionId: "s1" } }));
  await peer.receive("not json");
  await peer.receive(JSON.stringify({ id: 1, result: {} }));
  assert.deepEqual(seen, ["s1"]);
  const waiting = peer.request("initialize");
  peer.close("gone");
  await assert.rejects(waiting, /gone/);
  assert.throws(() => peer.notify("$/ping"), /closed/);
});
