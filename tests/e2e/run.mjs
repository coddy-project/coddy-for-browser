// The built extension in a real Chromium against a mock of Coddy's listener:
// connect, open a tab with the site approval, read and act on the page,
// files both ways, another chat refused, turnEnded, Stop.
//
//   npm run build
//   npm i --no-save playwright   # once; or NODE_PATH pointing at one
//   npm run e2e
//
// CODDY_BROWSER_PATH points at a Chromium to use instead of Playwright's own;
// CODDY_SCREENSHOT_DIR, when set, receives screenshots of the extension's pages.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startMockCoddy } from "./mock-coddy.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extension = path.join(root, "dist", "chrome");
const key = "e2e-key-0123456789abcdef0123456789";
const shots = process.env.CODDY_SCREENSHOT_DIR;

const waitFor = async (what, ok, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await ok();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const coddy = await startMockCoddy({ key });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "coddy-for-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  ...(process.env.CODDY_BROWSER_PATH ? { executablePath: process.env.CODDY_BROWSER_PATH } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [];
const capture = async (page, name, widths = [1280], { fit = true } = {}) => {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of widths) {
      if (fit) {
        await page.setViewportSize({ width, height: 200 });
        // Chrome sizes a popup to its content; so does the picture.
        const height = Math.max(200, await page.evaluate(() => document.documentElement.scrollHeight));
        await page.setViewportSize({ width, height });
      }
      await page.screenshot({ path: path.join(shots, `${name}-${theme}-${width}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: "dark" });
};

try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  // Node gives a chrome-extension: URL no origin of its own.
  const origin = worker.url().split("/").slice(0, 3).join("/");
  // The first install opens the settings page by itself; a launch that
  // loads the extension from a folder may not count as an install.
  const options =
    (await waitFor("the settings page", () => context.pages().find((p) => p.url().startsWith(origin + "/options.html")), 3000).catch(
      () => null,
    )) || (await context.newPage());
  if (!options.url().startsWith(origin)) await options.goto(origin + "/options.html");
  options.on("pageerror", (e) => errors.push(e.message));
  await options.setViewportSize({ width: 1280, height: 900 });
  await options.locator("#address").fill(coddy.base);
  await options.locator("#key").fill(key);
  await options.locator("#name").fill("Chrome - e2e");
  await options.getByRole("button", { name: "Save and connect" }).click();
  await options.locator("#status").getByText("Connected", { exact: true }).waitFor({ timeout: 15000 });
  await coddy.state.ready;
  assert.equal(coddy.state.hello.browser.name, "Chrome - e2e");
  assert.ok(coddy.state.hello.actions.includes("open_tab"));
  assert.deepEqual(coddy.state.tabs, []);
  await capture(options, "options-connected", [1280, 390]);

  // open_tab asks about the site in a window of the extension's own.
  const opening = coddy.command("open_tab", { params: { url: coddy.base + "/fixture" } });
  const approval = await waitFor("the approval window", () =>
    context.pages().find((p) => p.url().startsWith(origin + "/popup.html?approval")),
  );
  approval.on("pageerror", (e) => errors.push(e.message));
  await approval.getByRole("button", { name: "Always allow" }).waitFor();
  await approval.setViewportSize({ width: 420, height: 520 });
  await capture(approval, "site-approval", [420]);
  await approval.getByRole("button", { name: "Always allow" }).click();
  const opened = await opening;
  assert.equal(opened.url, coddy.base + "/fixture");
  await waitFor("the opened tab in the chat's group", () =>
    coddy.state.tabs.find((t) => t.id === opened.tabId && t.sessionId === "sess_e2e"),
  );
  const page = await waitFor("the fixture page", () => context.pages().find((p) => p.url() === coddy.base + "/fixture"));
  await page.setViewportSize({ width: 1000, height: 700 });

  const tab = { tabId: opened.tabId };
  const snapshot = await coddy.command("snapshot", tab);
  assert.match(snapshot.text, /Coddy fixture/);
  const ref = (name) => snapshot.elements.find((e) => e.name === name)?.ref;
  assert.equal(snapshot.elements.find((e) => e.name === "Secret").value, "(hidden)");
  assert.deepEqual(snapshot.tab, { id: opened.tabId, url: coddy.base + "/fixture", title: "Coddy fixture" });

  await coddy.command("click", { ...tab, params: { ref: ref("Click me") } });
  await page.getByRole("button", { name: "Clicked" }).waitFor();
  await coddy.command("type", { ...tab, params: { ref: ref("Name"), text: "Coddy input" } });
  assert.equal(await page.locator("#name").inputValue(), "Coddy input");
  await coddy.command("type", { ...tab, params: { ref: ref("Name"), text: "replaced", clear: true } });
  assert.equal(await page.locator("#name").inputValue(), "replaced");
  await coddy.command("press", { ...tab, params: { key: "Backspace" } });
  assert.equal(await page.locator("#name").inputValue(), "replace");
  await coddy.command("hover", { ...tab, params: { ref: ref("Hover me") } });
  await page.getByText("hovered").waitFor();
  // The glow and the Stop button are on the page while Coddy works.
  assert.equal(await page.locator("#coddy-for-browser-indicator").count(), 1);
  await capture(page, "tab-working", [1000], { fit: false });

  const picture = await coddy.command("screenshot", tab);
  assert.match(picture.dataUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(picture.dataUrl.split(",")[1], "base64");
  const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], viewport, "one image pixel per CSS pixel");

  const up = coddy.stage(Buffer.from("upload fixture"), true);
  await coddy.command("upload_file", { ...tab, params: { ref: ref("Upload"), transfer_id: up, filename: "example.txt" } });
  await waitFor("the upload", async () => (await page.title()) === "uploaded example.txt");
  const down = coddy.stage(null, false);
  const got = await coddy.command("download_file", { ...tab, params: { url: "/download", transfer_id: down, filename: "d.txt" } });
  assert.equal(got.bytes, 16);
  assert.equal(coddy.state.files.get(down).data.toString(), "download fixture");

  await coddy.command("scroll", { ...tab, params: { dy: 800 } });
  await waitFor("the scroll", async () => (await page.evaluate(() => scrollY)) > 0);

  // Another chat cannot act in this chat's tab.
  await assert.rejects(
    coddy.command("click", { ...tab, params: { x: 10, y: 10 }, session: { id: "sess_other" } }),
    (e) => e.data?.reason === "other_chat",
  );

  // The end of the turn takes the marks off.
  coddy.notify("browser/turnEnded", { sessionId: "sess_e2e" });
  await waitFor("the indicator to go", async () => (await page.locator("#coddy-for-browser-indicator").count()) === 0);

  // The popup shows the chat and the Stop button.
  const popup = await context.newPage();
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup.setViewportSize({ width: 360, height: 520 });
  await popup.goto(origin + "/popup.html");
  await popup.getByText("Chats using this browser").waitFor();
  await capture(popup, "popup-chat", [360]);

  // release hands the tab back to the shared group; Stop withdraws everything.
  assert.deepEqual(await coddy.command("release", {}), { released: 1 });
  await waitFor("the tab in the shared group", () => coddy.state.tabs.find((t) => t.id === opened.tabId && !t.sessionId));
  await popup.getByRole("button", { name: "Stop Coddy" }).click();
  await waitFor("browser/stop", () => coddy.state.stops === 1);
  await waitFor("no tab shared", () => coddy.state.tabs.length === 0);
  await assert.rejects(coddy.command("snapshot", tab), (e) => ["stopped", "not_shared"].includes(e.data?.reason));

  assert.deepEqual(errors, []);
  console.log("PASS: connect, site approval, open_tab, snapshot, click, type, press, hover, screenshot, upload, download, scroll, other chat refused, turnEnded, release, Stop");
} finally {
  await context.close();
  await coddy.close();
  await fs.rm(profile, { recursive: true, force: true });
}
