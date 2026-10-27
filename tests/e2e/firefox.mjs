// The Firefox build in a real Firefox against the mock of Coddy's HTTP
// server: connect, sites allowed beforehand and every website, the
// extension's own tab groups (Firefox for Android) over Firefox's tabs, the
// site approval window, open_tab, read the page, act on it through the page
// (Firefox has no debugger API), a screenshot through tabs.captureTab, files
// both ways, the side panel's web UI signed in by its ticket with a turn from
// the person's tab, a chat of another Coddy asking first, Disconnect.
//
//   npm run build
//   npm i --no-save puppeteer-core   # once; or NODE_PATH pointing at one
//   npm run e2e:firefox
//
// CODDY_FIREFOX_PATH names the Firefox to run (default: firefox on PATH);
// Firefox 140 or later. Puppeteer installs the extension over WebDriver BiDi,
// the way about:debugging loads a temporary add-on.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startMockCoddy } from "./mock-coddy.mjs";
import { GECKO_ID } from "../../scripts/build.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extension = path.join(root, "dist", "firefox");
const key = "e2e-key-0123456789abcdef0123456789";
// The extension's origin is a UUID Firefox picks per installation; the
// profile pins it, so the run knows where the extension's pages are.
const uuid = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const origin = `moz-extension://${uuid}`;

const waitFor = async (what, ok, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await ok();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// extensionPage finds an open page of the extension: over BiDi an extension
// page reports about:blank as its URL, so the page is asked itself.
async function extensionPage(file, timeout = 15000) {
  return waitFor(
    file,
    async () => {
      for (const p of await browser.pages()) {
        const href = await p.evaluate(() => location.href).catch(() => "");
        if (href.startsWith(`${origin}/${file}`)) return p;
      }
      return null;
    },
    timeout,
  );
}

// open loads a page; an extension page never reports its load over BiDi, so
// the run waits for what it needs on it instead.
async function open(page, url, selector) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
  await page.waitForSelector(selector, { timeout: 15000 });
}

// firefoxPath is CODDY_FIREFOX_PATH, or firefox found on PATH: Puppeteer
// takes a full path only.
function firefoxPath() {
  if (process.env.CODDY_FIREFOX_PATH) return process.env.CODDY_FIREFOX_PATH;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, process.platform === "win32" ? "firefox.exe" : "firefox");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("No firefox on PATH; set CODDY_FIREFOX_PATH");
}

const coddy = await startMockCoddy({ key });
const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: firefoxPath(),
  headless: true,
  // Firefox 150 and later let WebDriver BiDi open privileged pages - the
  // extension's own moz-extension: pages - only with this switch, and later
  // releases only with the environment variable as well; older versions
  // ignore both.
  args: ["-remote-allow-system-access"],
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  extraPrefsFirefox: {
    "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: uuid }),
    "intl.locale.requested": "en-US",
  },
});
const errors = [];
try {
  await browser.installExtension(extension);
  const options = await browser.newPage();
  options.on("pageerror", (e) => errors.push(e.message));
  await open(options, `${origin}/options.html`, "#address");
  await options.locator("#address").fill(coddy.base);
  await options.locator("#key").fill(key);
  await options.locator("#name").fill("Firefox - e2e");
  await options.locator("button.primary").click();
  await options
    .waitForFunction(() => document.querySelector("#status")?.textContent === "Connected", { timeout: 20000 })
    .catch(async (e) => {
      const why = await options.evaluate(() => [document.querySelector("#status")?.textContent, document.querySelector("#error")?.textContent]);
      throw new Error(`the extension did not connect: ${JSON.stringify(why)}`, { cause: e });
    });
  await coddy.state.ready;
  assert.equal(coddy.state.hello.browser.name, "Firefox - e2e");
  assert.ok(coddy.state.hello.actions.includes("click"));

  // The Firefox build holds every website from the install, so the list and
  // the switch for every website take another website without a prompt of
  // the browser's own (the Chromium run cannot answer Chrome's).
  await options.locator("#site").fill("example.com:1000-2000");
  await options.locator('button[aria-label="Add"]').click();
  await options.waitForSelector('#allowed span[title="*://example.com:1000-2000"]');
  await options.locator("#all").click();
  await options.waitForSelector('#all[aria-checked="true"]');
  await options.waitForSelector("#all-note:not([hidden])");
  await options.locator("#all").click();
  await options.waitForSelector('#all[aria-checked="false"]');
  await options.waitForSelector("#all-note[hidden]");

  // Firefox for Android has no tab groups: the extension's own
  // (virtualgroups.js) answer the same calls over a real Firefox's tabs, and
  // a group goes with its last tab.
  const virtual = await options.evaluate(async (url) => {
    const { withVirtualGroups } = await import(browser.runtime.getURL("virtualgroups.js"));
    let kept;
    const api = withVirtualGroups(browser, { get: async () => kept, set: async (v) => void (kept = structuredClone(v)) });
    const removed = [];
    api.tabGroups.onRemoved.addListener((g) => removed.push(g.id));
    const tab = await api.tabs.create({ url, active: false });
    const groupId = await api.tabs.group({ tabIds: [tab.id] });
    await api.tabGroups.update(groupId, { title: "Coddy" });
    const grouped = (await api.tabs.get(tab.id)).groupId === groupId && (await api.tabGroups.get(groupId)).title === "Coddy";
    const listed = (await api.tabs.query({})).some((t) => t.id === tab.id && t.groupId === groupId);
    await browser.tabs.remove(tab.id);
    await new Promise((r) => setTimeout(r, 300));
    return { grouped, listed, removed: removed.includes(groupId) };
  }, coddy.base + "/fixture?virtual");
  assert.deepEqual(virtual, { grouped: true, listed: true, removed: true });

  // open_tab asks about the site in a window of the extension's own.
  const opening = coddy.command("open_tab", { params: { url: coddy.base + "/fixture" } });
  const approval = await extensionPage("approval.html");
  await approval.locator("::-p-text(Always allow)").click();
  const opened = await opening;
  assert.equal(opened.url, coddy.base + "/fixture");
  await waitFor("the opened tab in the chat's group", () => coddy.state.tabs.find((t) => t.id === opened.tabId && t.sessionId === "sess_e2e"));
  const page = await waitFor("the fixture page", async () => (await browser.pages()).find((p) => p.url() === coddy.base + "/fixture"));

  const tab = { tabId: opened.tabId };
  const snapshot = await coddy.command("snapshot", tab);
  assert.match(snapshot.text, /Coddy fixture/);
  const ref = (name) => snapshot.elements.find((e) => e.name === name)?.ref;

  // Input goes through the page: the events reach the page's handlers, and
  // the result says a page could tell them from a person's.
  const clicked = await coddy.command("click", { ...tab, params: { ref: ref("Click me") } });
  assert.equal(clicked.trusted, false);
  await page.waitForFunction(() => document.querySelector("#b").textContent === "Clicked");
  await coddy.command("type", { ...tab, params: { ref: ref("Name"), text: "Coddy input" } });
  assert.equal(await page.$eval("#name", (e) => e.value), "Coddy input");
  await coddy.command("type", { ...tab, params: { ref: ref("Name"), text: "replaced", clear: true } });
  assert.equal(await page.$eval("#name", (e) => e.value), "replaced");
  await coddy.command("press", { ...tab, params: { key: "Backspace" } });
  assert.equal(await page.$eval("#name", (e) => e.value), "replace");
  await coddy.command("hover", { ...tab, params: { ref: ref("Hover me") } });
  await page.waitForFunction(() => document.querySelector("#hover").textContent === "hovered");

  const picture = await coddy.command("screenshot", tab);
  assert.match(picture.dataUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(picture.dataUrl.split(",")[1], "base64");
  const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], viewport, "one image pixel per CSS pixel");

  const up = coddy.stage(Buffer.from("upload fixture"), true);
  await coddy.command("upload_file", { ...tab, params: { ref: ref("Upload"), transfer_id: up, filename: "example.txt" } });
  await page.waitForFunction(() => document.title === "uploaded example.txt");
  const down = coddy.stage(null, false);
  const got = await coddy.command("download_file", { ...tab, params: { url: "/download", transfer_id: down, filename: "d.txt" } });
  assert.equal(got.bytes, 16);
  assert.equal(coddy.state.files.get(down).data.toString(), "download fixture");

  await coddy.command("scroll", { ...tab, params: { dy: 800 } });
  await page.waitForFunction(() => scrollY > 0);
  coddy.notify("browser/turnEnded", { sessionId: "sess_e2e" });

  // The side panel - Firefox's sidebar, opened here as a tab - shows the web
  // UI signed in by its ticket, in the web UI's theme, and a turn from it
  // takes the tab the person looks at.
  const mine = await browser.newPage();
  await mine.goto(coddy.base + "/fixture?mine");
  const panel = await browser.newPage();
  panel.on("pageerror", (e) => errors.push(e.message));
  await open(panel, `${origin}/panel.html`, "#webui");
  await panel.waitForSelector("#webui:not([hidden])", { timeout: 20000 });
  // Over BiDi the frame of an extension page is out of the run's reach, so
  // the web UI is driven through the mock server (mock-coddy.mjs).
  await waitFor("the web UI signed in by its ticket", () => coddy.state.signins === 1, 20000);
  await panel.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  coddy.send("Read this page");
  await waitFor("the answer in the web UI", () => coddy.state.answer === "The page is Coddy fixture.", 20000);
  assert.equal(coddy.state.turn.tab.url, coddy.base + "/fixture?mine");
  const mineTab = coddy.state.turn.tab.tab_id;
  await waitFor("the person's tab in the chat's group", () => coddy.state.tabs.find((t) => t.id === mineTab && t.sessionId === "sess_panel_1"));

  // A chat of another Coddy asks first, in the panel.
  const laptop = { id: "laptop/sess_trip", title: "Trip", node: "laptop" };
  const remote = coddy.command("open_tab", { params: { url: coddy.base + "/fixture?remote" }, session: laptop });
  remote.catch(() => {}); // refused before the assertion below takes it
  await panel.locator("::-p-text(A chat of another Coddy asks to use this browser)").wait();
  await panel.locator("::-p-text(Decline)").click();
  await assert.rejects(remote, (e) => e.data?.reason === "chat_declined");

  // Disconnect on the settings page withdraws everything.
  // Firefox 150 and later refuse to bring a privileged page to the front over
  // BiDi, and input does not reach a page behind another, so the button is
  // pressed from the page itself: what it does is what this checks.
  await options.evaluate(() => document.querySelector("#disconnect").click());
  await waitFor("browser/stop", () => coddy.state.stops === 1);
  await waitFor("no tab shared", () => coddy.state.tabs.length === 0);

  assert.deepEqual(errors, []);
  console.log("PASS (Firefox): connect, sites allowed beforehand and every website, the extension's own tab groups over Firefox's tabs, site approval, open_tab, snapshot, click, type, press, hover through the page, screenshot through captureTab, upload, download, scroll, side panel web UI signed in by its ticket with a turn from the person's tab, a chat of another Coddy asking first, Disconnect");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await coddy.close();
}
