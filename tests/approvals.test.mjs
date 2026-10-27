import test from "node:test";
import assert from "node:assert/strict";
import { Approvals } from "../src/approvals.js";
import { memoryStore } from "./fake-chrome.mjs";

async function setup(timeoutMs) {
  let changes = 0;
  const store = memoryStore();
  const a = new Approvals({ store, onChange: () => changes++, timeoutMs });
  await a.load();
  return { a, store, changes: () => changes };
}

test("the first action on a site waits for the user, and the answer holds for the chat", async () => {
  const { a, changes } = await setup();
  const asked = a.ensure("https://example.com", { id: "s1", title: "Chat" }, "click");
  const [q] = a.list();
  assert.deepEqual(q.session, { id: "s1", title: "Chat" });
  assert.equal(q.origin, "https://example.com");
  await a.decide(q.id, "chat");
  await asked;
  assert.ok(changes() >= 2);
  await a.ensure("https://example.com", { id: "s1" }, "type");
  assert.equal(a.list().length, 0);
  const other = a.ensure("https://example.com", { id: "s2" }, "click");
  assert.equal(a.list().length, 1);
  await a.decide(a.list()[0].id, "always");
  await other;
  await a.ensure("https://example.com", { id: "s3" }, "click");
});

test("one answer settles every question about the same site and chat", async () => {
  const { a } = await setup();
  const one = a.ensure("https://example.com", { id: "s1" }, "click");
  const two = a.ensure("https://example.com", { id: "s1" }, "type");
  await a.decide(a.list()[0].id, "chat");
  await Promise.all([one, two]);
  assert.equal(a.list().length, 0);
});

test("decline, timeout, cancel and Stop refuse with a reason", async () => {
  const { a } = await setup(30);
  const declined = a.ensure("https://example.com", { id: "s1" }, "click");
  await a.decide(a.list()[0].id, "deny");
  await assert.rejects(declined, (e) => e.reason === "site_declined");
  await assert.rejects(a.ensure("https://slow.example", { id: "s1" }, "click"), (e) => e.reason === "site_prompt_timeout");
  const abort = new AbortController();
  const cancelled = a.ensure("https://c.example", { id: "s1" }, "click", abort.signal);
  abort.abort();
  await assert.rejects(cancelled, (e) => e.reason === "cancelled");
  const stopped = a.ensure("https://d.example", { id: "s1" }, "click");
  a.cancelAll();
  await assert.rejects(stopped, (e) => e.reason === "site_declined");
  await assert.rejects(a.decide("nope", "chat"), /already answered/);
});

test("an always grant is kept and a revoke asks again", async () => {
  const { a, store } = await setup(30);
  await a.allow("https://example.com", "s1", "always");
  assert.deepEqual(store.peek().always, ["https://example.com"]);
  await a.ensure("https://example.com", { id: "s9" }, "click");
  await a.revoke("https://example.com");
  await assert.rejects(a.ensure("https://example.com", { id: "s9" }, "click"), (e) => e.reason === "site_prompt_timeout");
});

test("a command cancelled before its question asks nothing", async () => {
  const { a } = await setup();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(a.ensure("https://example.com", { id: "s1" }, "click", abort.signal), (e) => e.reason === "cancelled");
  assert.equal(a.list().length, 0);
});

test("a site allowed always outlives the browser, a chat's answer does not", async () => {
  const store = memoryStore();
  const session = memoryStore();
  const a = new Approvals({ store, sessionStore: session });
  await a.load();
  await a.allow("https://always.example", "s1", "always");
  await a.allow("https://chat.example", "s1", "chat");
  assert.deepEqual(store.peek(), { always: ["https://always.example"] });
  assert.deepEqual(session.peek().chats, { s1: ["https://chat.example"] });
});
