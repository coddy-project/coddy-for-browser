import test from "node:test";
import assert from "node:assert/strict";
import { parseKey, cdpAction, Debugger } from "../src/input.js";
import { fakeDebugger } from "./fake-chrome.mjs";

test("keys and shortcuts map to CDP key events", () => {
  assert.deepEqual(parseKey("Enter"), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", modifiers: 0 });
  assert.deepEqual(parseKey("Ctrl+A"), { key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: undefined, modifiers: 2 });
  assert.equal(parseKey("Shift+a").text, "A");
  assert.equal(parseKey("Cmd+Shift+K").modifiers, 12);
  assert.equal(parseKey("7").code, "Digit7");
  assert.throws(() => parseKey("Hyper+A"), /modifier/);
  assert.throws(() => parseKey("F13"), /Unsupported key/);
  assert.throws(() => parseKey(""), /needs a key/);
});

test("a drag presses, moves in steps and releases where it ends", async () => {
  const dbg = fakeDebugger();
  await cdpAction(dbg, 1, "drag", { x: 0, y: 0, to_x: 80, to_y: 40 });
  const kinds = dbg.sent.map(([, , p]) => p.type);
  assert.equal(kinds[1], "mousePressed");
  assert.equal(kinds.at(-1), "mouseReleased");
  assert.equal(kinds.filter((k) => k === "mouseMoved").length, 9);
  const release = dbg.sent.at(-1)[2];
  assert.deepEqual([release.x, release.y], [80, 40]);
});

test("a key with a character goes in as keyDown with its text, a shortcut as rawKeyDown", async () => {
  const dbg = fakeDebugger();
  await cdpAction(dbg, 1, "press", { key: "Enter" });
  await cdpAction(dbg, 1, "press", { key: "Ctrl+A" });
  assert.equal(dbg.sent[0][2].type, "keyDown");
  assert.equal(dbg.sent[0][2].text, "\r");
  assert.equal(dbg.sent[2][2].type, "rawKeyDown");
  assert.equal(dbg.sent[2][2].text, undefined);
});

test("a click refuses an unknown button", async () => {
  await assert.rejects(cdpAction(fakeDebugger(), 1, "click", { x: 1, y: 1, button: "fourth" }), /button/);
});

test("two first actions on a tab share one debugger attachment", async () => {
  let attaches = 0;
  const api = {
    debugger: {
      onDetach: { addListener() {} },
      attach: () => new Promise((r) => setTimeout(() => (attaches++, r()), 5)),
      detach: async () => {},
      sendCommand: async () => ({}),
    },
  };
  const dbg = new Debugger(api);
  await Promise.all([dbg.attach(7), dbg.attach(7)]);
  assert.equal(attaches, 1);
  assert.equal(dbg.attached.get(7).own, true);
  await dbg.detachAll();
});

test("a stopped multi-step action sends no further step, and a drag still releases", async () => {
  const dbg = fakeDebugger();
  let stopped = false;
  const guard = () => {
    if (stopped) throw new Error("stopped");
  };
  const moving = dbg.send;
  dbg.send = async (...args) => {
    const r = await moving(...args);
    if (args[1] === "Input.dispatchMouseEvent" && args[2].type === "mousePressed") stopped = true;
    return r;
  };
  await assert.rejects(cdpAction(dbg, 1, "drag", { x: 0, y: 0, to_x: 80, to_y: 0 }, null, guard), /stopped/);
  const types = dbg.sent.map(([, , p]) => p.type);
  assert.deepEqual(types, ["mouseMoved", "mousePressed", "mouseReleased"]);
});
