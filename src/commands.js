// The actions Coddy asks of the browser (browser/command). Each one is
// checked here before it touches a page: the selection it was sent for is
// still current, the tab is the chat's to use, and the user allowed the
// website.

import { siteOf, fileURL } from "./policy.js";
import { failure } from "./rpc.js";
import { pageAction } from "./page.js";
import { cdpAction } from "./input.js";
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
const LOAD_TIMEOUT_MS = 20000;

function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

export class Commands {
  // deps: api (chrome), groups, approvals, dbg (Debugger), settings() ->
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

  waitLoaded(tabId, signal) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.api.tabs.onUpdated.removeListener(listener);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") done();
      };
      const timer = setTimeout(done, LOAD_TIMEOUT_MS);
      signal?.addEventListener("abort", done, { once: true });
      this.api.tabs.onUpdated.addListener(listener);
      this.api.tabs.get(tabId).then(
        (t) => t.status === "complete" && done(),
        () => done(),
      );
    });
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
    const session = { id: String(cmd.session?.id || ""), title: String(cmd.session?.title || "") };
    if (!session.id) throw failure("invalid_params", "The command names no chat");
    if (!ACTIONS.includes(cmd.action)) throw failure("unsupported", `Unsupported action ${cmd.action}`);

    if (cmd.action === "release") {
      const released = await this.groups.release(session.id);
      await this.publish();
      return { released };
    }
    if (cmd.action === "open_tab") {
      const origin = siteOf(p.url);
      await this.approvals.ensure(origin, session, "open a tab", signal);
      check();
      const tab = await this.groups.open(p.url, session);
      await this.groups.setWorking(session, true);
      // Coddy learns the tab before the answer that names it.
      await this.publish();
      await this.waitLoaded(tab.id, signal);
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
    await this.approvals.ensure(origin, session, cmd.action.replace("_", " "), signal);
    check();
    tab = await this.api.tabs.get(tab.id);
    if (siteOf(tab.url) !== origin || this.groups.ownerOf(tab) !== session.id)
      throw failure("page_changed", "The page changed while waiting for permission; take a new snapshot");
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
          await (p.url === "back" ? this.api.tabs.goBack(tab.id) : this.api.tabs.goForward(tab.id));
        } else {
          const target = siteOf(new URL(p.url, tab.url).href);
          if (target !== origin) await this.approvals.ensure(target, session, "navigate", signal);
          check();
          await this.api.tabs.update(tab.id, { url: new URL(p.url, tab.url).href });
        }
        await this.waitLoaded(tab.id, signal);
        const now = await this.api.tabs.get(tab.id);
        await this.mark(tab.id, true, session);
        return { url: now.url, title: now.title || "" };
      }
      case "snapshot":
        result = await page("snapshot");
        break;
      case "screenshot": {
        const view = await page("viewport");
        await this.mark(tab.id, false, session);
        try {
          result = await cdpAction(this.dbg, tab.id, "screenshot", { scale: view.scale }, expected);
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
        if (cmd.action === "type" && p.ref) {
          // A click puts the caret where a person would put it.
          await cdpAction(this.dbg, tab.id, "click", { x: p.x, y: p.y }, expected);
        }
        if (cmd.action === "scroll" && (p.x === undefined || p.y === undefined)) {
          const view = await page("viewport");
          p.x ??= Math.round(view.width / 2);
          p.y ??= Math.round(view.height / 2);
        }
        for (const k of cmd.action === "drag" ? ["x", "y", "to_x", "to_y"] : ["click", "hover"].includes(cmd.action) ? ["x", "y"] : [])
          if (!Number.isFinite(Number(p[k]))) throw failure("invalid_params", `${cmd.action} needs ${k} or a ref`);
        check();
        result = await cdpAction(this.dbg, tab.id, cmd.action, p, expected);
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
        if (target !== origin) await this.approvals.ensure(target, session, "download", signal);
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
