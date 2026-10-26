// Trusted input and screenshots through the Chrome DevTools Protocol. The
// debugger stays attached to a tab while Coddy works there and detaches after
// a short idle, so Chrome's "started debugging this browser" bar does not
// flicker on every click.

const IDLE_MS = 20000;
const VERSION = "1.3";

export class Debugger {
  constructor(api) {
    this.api = api;
    this.attached = new Map();
    api.debugger.onDetach.addListener((source) => this.forget(source.tabId));
  }

  forget(tabId) {
    const entry = this.attached.get(tabId);
    if (entry) clearTimeout(entry.timer);
    this.attached.delete(tabId);
  }

  async attach(tabId) {
    let entry = this.attached.get(tabId);
    if (!entry) {
      let own = true;
      try {
        await this.api.debugger.attach({ tabId }, VERSION);
      } catch (e) {
        // DevTools open on the tab holds the attachment; use it and leave it
        // alone when done.
        if (!/already attached/i.test(String(e?.message || e))) throw e;
        own = false;
      }
      entry = { own, timer: null };
      this.attached.set(tabId, entry);
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.detach(tabId), IDLE_MS);
    return entry;
  }

  async detach(tabId) {
    const entry = this.attached.get(tabId);
    this.forget(tabId);
    if (entry?.own) await this.api.debugger.detach({ tabId }).catch(() => {});
  }

  async detachAll() {
    await Promise.all([...this.attached.keys()].map((id) => this.detach(id)));
  }

  // send runs one CDP command after checking the tab still shows the page the
  // action was approved for.
  async send(tabId, method, params, expected) {
    await this.attach(tabId);
    if (expected) {
      const { frameTree } = await this.api.debugger.sendCommand({ tabId }, "Page.getFrameTree");
      const origin = new URL(frameTree.frame.url).origin;
      if (origin !== expected.origin || (expected.loaderId && expected.loaderId !== frameTree.frame.loaderId))
        throw Object.assign(new Error("The page changed during the action; take a new snapshot"), {
          reason: "page_changed",
        });
      expected.loaderId ||= frameTree.frame.loaderId;
    }
    return this.api.debugger.sendCommand({ tabId }, method, params);
  }
}

const KEYS = {
  Enter: [13, "Enter", "\r"],
  Tab: [9, "Tab"],
  Backspace: [8, "Backspace"],
  Delete: [46, "Delete"],
  Escape: [27, "Escape"],
  ArrowLeft: [37, "ArrowLeft"],
  ArrowUp: [38, "ArrowUp"],
  ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"],
  Home: [36, "Home"],
  End: [35, "End"],
  PageUp: [33, "PageUp"],
  PageDown: [34, "PageDown"],
  Space: [32, "Space", " "],
};
const MODIFIERS = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };

// parseKey turns "Ctrl+Shift+K" into what Input.dispatchKeyEvent takes.
export function parseKey(spec) {
  const parts = String(spec || "").split("+").filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error("press needs a key");
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m];
    if (!bit) throw new Error(`Unsupported key modifier ${m}`);
    modifiers |= bit;
  }
  let key = KEYS[name];
  if (!key && /^[a-z0-9]$/i.test(name)) {
    const code = /^\d$/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`;
    // A character goes in only without Ctrl, Alt or Meta, which make it a
    // shortcut instead.
    key = [name.toUpperCase().charCodeAt(0), code, modifiers & 7 ? undefined : modifiers & 8 ? name.toUpperCase() : name];
  }
  if (!key) throw new Error(`Unsupported key ${name}`);
  const [windowsVirtualKeyCode, code, text] = key;
  return { key: name, code, windowsVirtualKeyCode, text, modifiers };
}

const BUTTONS = ["left", "right", "middle"];

export async function cdpAction(dbg, tabId, action, p, expected) {
  const send = (method, params) => dbg.send(tabId, method, params, expected);
  if (action === "screenshot") {
    // One image pixel per CSS pixel: the coordinates the model reads off the
    // picture are the ones click takes.
    const { cssLayoutViewport } = await send("Page.getLayoutMetrics", {});
    const width = Math.round(cssLayoutViewport.clientWidth);
    const height = Math.round(cssLayoutViewport.clientHeight);
    // p.scale is the page's devicePixelRatio; the clip's scale undoes it.
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: cssLayoutViewport.pageX, y: cssLayoutViewport.pageY, width, height, scale: 1 / (p.scale || 1) },
    });
    return { dataUrl: `data:image/png;base64,${data}`, width, height };
  }
  if (action === "click") {
    const button = p.button || "left";
    if (!BUTTONS.includes(button)) throw new Error("button is left, right or middle");
    const count = Math.min(Math.max(Number(p.count) || 1, 1), 3);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    for (let i = 1; i <= count; i++) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, clickCount: i });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button, clickCount: i });
    }
    return { ok: true };
  }
  if (action === "hover") {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    return { ok: true };
  }
  if (action === "type") {
    if (p.clear) {
      const mac = /Mac/.test(navigator.platform);
      const selectAll = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: mac ? 4 : 2 };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...selectAll, commands: ["selectAll"] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...selectAll });
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    }
    await send("Input.insertText", { text: String(p.text ?? "") });
    return { ok: true };
  }
  if (action === "press") {
    const k = parseKey(p.key);
    const { text, ...rest } = k;
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...rest, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...rest });
    return { ok: true };
  }
  if (action === "scroll") {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: p.x,
      y: p.y,
      deltaX: Number(p.dx) || 0,
      deltaY: Number(p.dy) || 0,
    });
    return { ok: true };
  }
  if (action === "drag") {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = p.x + ((p.to_x - p.x) * i) / steps;
      const y = p.y + ((p.to_y - p.y) * i) / steps;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.to_x, y: p.to_y, button: "left", clickCount: 1 });
    return { ok: true };
  }
  throw new Error("Unsupported input action");
}
