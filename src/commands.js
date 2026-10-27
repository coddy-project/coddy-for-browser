// The actions Coddy asks of the browser (browser/command). Each one is
// checked here before it touches a page: the selection it was sent for is
// still current, the tab is the chat's to use, and the user allowed the
// website.

import { siteOf, fileURL } from "./policy.js";
import { failure } from "./rpc.js";
import { pageAction } from "./page.js";
import { indicator } from "./indicator.js";

export const ACTIONS = [
  "open_tab",
  "close_tab",
  "release",
  "snapshot",
  "screenshot",
  "navigate",
  "click",
  "type",
  "press",
  "hover",
  "scroll",
  "drag",
  "upload_file",
  "download_file",
];

export const MAX_FILE_BYTES = 32 * 1024 * 1024;

// chatOf reads the chat a command is for. A chat of another Coddy process
// names its node; its tab group carries the node next to the title
// (groups.chatTitle), so the user sees where the chat working in a tab runs.
export function chatOf(raw) {
  const id = String(raw?.id || "");
  const node = String(raw?.node || "").slice(0, 64);
  const title = String(raw?.title || "");
  return node ? { id, title, node } : { id, title };
}
const LOAD_TIMEOUT_MS = 20000;

function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

export class Commands {
  // deps: api (chrome or browser), groups, approvals, input (cdpInput where
  // the browser has the debugger, pageInput where it has not), settings() ->
  // {address, key}, grant() -> the current grant, publish() announcing the
  // tabs, fetch.
  constructor(deps) {
    Object.assign(this, deps);
    this.fetch ||= globalThis.fetch.bind(globalThis);
  }

  async script(tabId, action, params) {
    const [r] = await this.api.scripting.executeScript({ target: { tabId }, func: pageAction, args: [action, params] });
    if (!r || r.error || r.result === undefined)
      throw failure("page_changed", r?.error?.message || "The page did not answer; take a new snapshot");
    return r.result;
  }

  async mark(tabId, on, session) {
    const label = on ? `Coddy is working${session.title ? " · " + session.title.slice(0, 40) : ""}` : "";
    await this.api.scripting
      .executeScript({ target: { tabId }, func: indicator, args: [on, label] })
      .catch(() => {});
  }

  // waitLoaded waits for the page a navigation leads to: the tab complete,
  // past about:blank, and on a page other than from (the one it showed
  // before) unless it went through loading meanwhile, which a reload of the
  // same address does. Firefox reports a new tab complete while it still
  // shows about:blank, and a tab being navigated complete until the load
  // starts.
  waitLoaded(tabId, signal, { from = "about:blank" } = {}) {
    return new Promise((resolve) => {
      let loading = false;
      const arrived = (t) => t?.status === "complete" && t.url && t.url !== "about:blank" && (loading || t.url !== from);
      const done = () => {
        clearTimeout(timer);
        this.api.tabs.onUpdated.removeListener(listener);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const listener = (id, info, tab) => {
        if (id !== tabId) return;
        if (info.status === "loading") loading = true;
        if (arrived(tab)) done();
      };
      const timer = setTimeout(done, LOAD_TIMEOUT_MS);
      signal?.addEventListener("abort", done, { once: true });
      this.api.tabs.onUpdated.addListener(listener);
      this.api.tabs.get(tabId).then(
        (t) => arrived(t) && done(),
        () => done(),
      );
    });
  }

  // historyStep goes back or forward. With the debugger the entry is read
  // first, and a step to another website asks about that site before going
  // there; without it (Firefox) the browser steps and the next action on the
  // new site asks.
  async historyStep(tab, direction, origin, session, expected, signal, check, stillOurs) {
    if (this.input.history) {
      const { currentIndex, entries } = await this.input.history(tab.id, expected);
      const entry = entries[currentIndex + (direction === "back" ? -1 : 1)];
      if (!entry) throw failure("invalid_params", `There is no page to go ${direction} to`);
      let target = "";
      try {
        target = siteOf(entry.url);
      } catch {
        throw failure("invalid_params", `The page ${direction} is not a web page`);
      }
      if (target !== origin) {
        await this.approvals.ensure(target, session, "navigate", signal);
        check();
        await stillOurs();
      }
      await this.input.go(tab.id, entry.id, expected);
      return;
    }
    await (direction === "back" ? this.api.tabs.goBack(tab.id) : this.api.tabs.goForward(tab.id));
  }

  // handle answers one browser/command.
  async handle(cmd, signal) {
    const check = () => {
      if (signal?.aborted) throw failure("cancelled", "The action was cancelled");
      if (cmd.grant !== this.grant())
        throw failure("stopped", "The user stopped Coddy or changed what is shared; list the tabs again");
    };
    check();
    const p = cmd.params && typeof cmd.params === "object" ? { ...cmd.params } : {};
    const session = chatOf(cmd.session);
    if (!session.id) throw failure("invalid_params", "The command names no chat");
    if (!ACTIONS.includes(cmd.action)) throw failure("unsupported", `Unsupported action ${cmd.action}`);
    // A chat of another Coddy asks the user first; handing tabs back needs
    // no question.
    if (cmd.action !== "release") {
      await this.approvals.ensureChat(session, signal);
      check();
    }

    if (cmd.action === "release") {
      const released = await this.groups.release(session.id);
      for (const id of released) await this.mark(id, false, session);
      await this.publish();
      return { released: released.length };
    }
    if (cmd.action === "open_tab") {
      const origin = siteOf(p.url);
      await this.approvals.ensure(origin, session, "open a tab", signal);
      check();
      const tab = await this.groups.open(p.url, session);
      check();
      await this.groups.setWorking(session, true);
      // Coddy learns the tab before the answer that names it.
      await this.publish();
      await this.waitLoaded(tab.id, signal);
      check();
      const loaded = await this.api.tabs.get(tab.id);
      return { tabId: tab.id, url: loaded.url, title: loaded.title || "" };
    }

    let tab = await this.api.tabs.get(cmd.tabId).catch(() => null);
    if (!tab) throw failure("not_shared", "The tab is closed");
    const before = this.groups.ownerOf(tab);
    tab = await this.groups.claim(cmd.tabId, session);
    if (before === "") await this.publish();
    let origin;
    try {
      origin = siteOf(tab.url);
    } catch {
      throw failure("not_shared", "The tab does not show a web page");
    }
    try {
      await this.approvals.ensure(origin, session, cmd.action.replace("_", " "), signal);
    } catch (e) {
      // A shared tab the chat took for an action the user declined goes back
      // to the shared group.
      if (before === "") {
        await this.groups.share(tab.id).catch(() => {});
        await this.publish();
      }
      throw e;
    }
    check();
    // stillOurs is the tab after a question was waited on: still the chat's,
    // still on the site that was approved.
    const stillOurs = async (site = origin) => {
      const now = await this.api.tabs.get(tab.id).catch(() => null);
      let at = "";
      try {
        at = siteOf(now?.url);
      } catch {}
      if (!now || at !== site || this.groups.ownerOf(now) !== session.id)
        throw failure("page_changed", "The page changed while waiting for permission; take a new snapshot");
      return now;
    };
    tab = await stillOurs();
    await this.groups.setWorking(session, true);
    if (cmd.action !== "close_tab") await this.mark(tab.id, true, session);
    const expected = { origin };
    const page = (action, params = {}) => this.script(tab.id, action, { ...params, expected_origin: origin });
    let result;

    switch (cmd.action) {
      case "close_tab":
        await this.api.tabs.remove(tab.id);
        await this.publish();
        return { closed: true };
      case "navigate": {
        if (p.url === "back" || p.url === "forward") {
          await this.historyStep(tab, p.url, origin, session, expected, signal, check, stillOurs);
        } else {
          const target = siteOf(new URL(p.url, tab.url).href);
          if (target !== origin) {
            await this.approvals.ensure(target, session, "navigate", signal);
            check();
            await stillOurs();
          }
          await this.api.tabs.update(tab.id, { url: new URL(p.url, tab.url).href });
        }
        await this.waitLoaded(tab.id, signal, { from: tab.url });
        check();
        const now = await this.api.tabs.get(tab.id);
        await this.mark(tab.id, true, session);
        result = { url: now.url, title: now.title || "" };
        break;
      }
      case "snapshot":
        result = await page("snapshot");
        break;
      case "screenshot": {
        const view = await page("viewport");
        await this.mark(tab.id, false, session);
        try {
          result = await this.input.screenshot(tab.id, view, expected);
        } finally {
          await this.mark(tab.id, true, session);
        }
        break;
      }
      case "click":
      case "hover":
      case "type":
      case "press":
      case "scroll":
      case "drag": {
        if (p.ref) Object.assign(p, await page("target", { ref: p.ref, focus: cmd.action === "type" }));
        if (cmd.action === "scroll" && (p.x === undefined || p.y === undefined)) {
          const view = await page("viewport");
          p.x ??= Math.round(view.width / 2);
          p.y ??= Math.round(view.height / 2);
        }
        for (const k of cmd.action === "drag" ? ["x", "y", "to_x", "to_y"] : ["click", "hover"].includes(cmd.action) ? ["x", "y"] : [])
          if (!Number.isFinite(Number(p[k]))) throw failure("invalid_params", `${cmd.action} needs ${k} or a ref`);
        // Input lands in whatever frame is at the point, or has the focus:
        // a frame of another website is not covered by this page's approval.
        const points = [];
        if (Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) points.push({ x: Number(p.x), y: Number(p.y) });
        if (cmd.action === "drag") points.push({ x: Number(p.to_x), y: Number(p.to_y) });
        const hit = await page("hit", { points, focus: cmd.action === "type" || cmd.action === "press" });
        if (hit?.crossOrigin)
          throw failure("cross_origin_frame", "The point is inside a frame of another website; open its address in a tab of its own");
        check();
        if (cmd.action === "type" && p.ref) {
          // A click puts the caret where a person would put it.
          await this.input.act(tab.id, "click", { x: p.x, y: p.y }, expected, check);
        }
        result = await this.input.act(tab.id, cmd.action, p, expected, check);
        break;
      }
      case "upload_file": {
        const response = await this.fetch(fileURL(this.settings().address, p.transfer_id), {
          headers: { Authorization: `Bearer ${this.settings().key}` },
          redirect: "error",
          signal,
        });
        if (!response.ok) throw failure("transfer_failed", `The file transfer failed (${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES) throw failure("too_large", "The file exceeds 32 MiB");
        check();
        result = await page("upload_file", { ref: p.ref, filename: String(p.filename || "file"), base64: toBase64(bytes) });
        break;
      }
      case "download_file": {
        const address = new URL(p.url, tab.url);
        const target = siteOf(address.href);
        if (target !== origin) {
          await this.approvals.ensure(target, session, "download", signal);
          check();
          await stillOurs();
        }
        check();
        const response = await this.fetch(address.href, { credentials: "include", redirect: "error", signal });
        if (!response.ok) throw failure("download_failed", `The download failed (${response.status})`);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_FILE_BYTES) {
            await reader.cancel();
            throw failure("too_large", "The file exceeds 32 MiB");
          }
          chunks.push(value);
        }
        check();
        const posted = await this.fetch(fileURL(this.settings().address, p.transfer_id), {
          method: "POST",
          headers: { Authorization: `Bearer ${this.settings().key}` },
          body: new Blob(chunks),
          redirect: "error",
          signal,
        });
        if (!posted.ok) throw failure("transfer_failed", `The file transfer failed (${posted.status})`);
        result = { bytes: size, filename: p.filename };
        break;
      }
    }
    check();
    const now = await this.api.tabs.get(tab.id).catch(() => tab);
    return { ...result, tab: { id: now.id, url: now.url, title: now.title || "" } };
  }
}
