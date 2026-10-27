// The built extension in a real Chromium against a mock of Coddy's HTTP
// server: connect, open a tab with the site approval, read and act on the
// page, files both ways, another chat refused, turnEnded, the side panel's
// web UI signed in by its ticket and a turn sent from it with the person's
// tab, a chat of another Coddy asking first, Disconnect on the settings page.
//
//   npm run build
//   npm i --no-save playwright   # once; or NODE_PATH pointing at one
//   npm run e2e
//
// CODDY_BROWSER_PATH points at a Chromium-family browser to use instead of
// Playwright's own Chromium - Google Chrome, Yandex Browser - which gets the
// extension through the DevTools protocol (launch.mjs). CODDY_SCREENSHOT_DIR,
// when set, receives screenshots of the extension's pages. Firefox has a run
// of its own, firefox.mjs.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startMockCoddy } from "./mock-coddy.mjs";
import { launchChromium } from "./launch.mjs";

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
const { context, close } = await launchChromium(chromium, extension);
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
    context.pages().find((p) => p.url().startsWith(origin + "/approval.html")),
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
  await page.setViewportSize({ width: 1280, height: 720 });

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
  await capture(page, "tab-working", [1280], { fit: false });

  const picture = await coddy.command("screenshot", tab);
  assert.match(picture.dataUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(picture.dataUrl.split(",")[1], "base64");
  // The visible part of the page: a browser that draws its scrollbar
  // (Yandex Browser) leaves it out.
  const viewport = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.clientHeight]);
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

  // The side panel: the web UI of the server in a frame, signed in by a
  // one-time ticket, its strip in the web UI's theme. A turn sent from it
  // takes the tab the person looks at into the turn's chat first.
  const mine = await context.newPage();
  await mine.goto(coddy.base + "/fixture?mine");
  await mine.bringToFront();
  const panel = await context.newPage();
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.setViewportSize({ width: 420, height: 720 });
  await panel.goto(origin + "/panel.html");
  const webUI = panel.frameLocator("#webui");
  await webUI.getByText("Signed in").waitFor();
  assert.equal(coddy.state.signins, 1);
  await waitFor("the strip in the web UI's theme", async () =>
    (await panel.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()])).join() ===
    "dark,rgb(15, 15, 16)",
  );
  await panel.locator("#tabbar").getByText("taken when you send").waitFor();
  await capture(panel, "panel-webui", [420], { fit: false });
  await webUI.locator("#composer").fill("Read this page");
  await webUI.getByRole("button", { name: "Send" }).click();
  await webUI.getByText("The page is Coddy fixture.").waitFor();
  assert.equal(coddy.state.turn.tab.url, coddy.base + "/fixture?mine");
  assert.equal(coddy.state.turn.tab.browser_id, coddy.state.hello.browser.id);
  const mineTab = coddy.state.turn.tab.tab_id;
  await waitFor("the person's tab in the chat's group", () =>
    coddy.state.tabs.find((t) => t.id === mineTab && t.sessionId === "sess_panel_1"),
  );
  await panel.locator("#tabbar").getByText('in "Read this page"').waitFor();
  // Take back ungroups the tab; Share puts it in the shared group.
  await panel.locator("#tabbar").getByRole("button", { name: "Take back" }).click();
  await waitFor("the tab out of every group", () => !coddy.state.tabs.find((t) => t.id === mineTab));
  await panel.locator("#tabbar").getByRole("button", { name: "Share" }).click();
  await waitFor("the tab in the shared group", () => coddy.state.tabs.find((t) => t.id === mineTab && !t.sessionId));
  await panel.locator("#tabbar").getByText("shared").waitFor();

  // A chat of another Coddy asks first, in the panel, and the site it
  // reaches asks again for it: "always" covers only the server's own chats.
  const laptop = { id: "laptop/sess_trip", title: "Trip", node: "laptop" };
  const remote = coddy.command("snapshot", { tabId: mineTab, session: laptop });
  await panel.getByText("A chat of another Coddy asks to use this browser").waitFor();
  await panel.getByText('The chat "Trip" runs on laptop').waitFor();
  await capture(panel, "panel-remote-chat", [420], { fit: false });
  await panel.getByRole("button", { name: "Allow for this chat" }).click();
  await panel.getByText("Coddy asks to use a website").waitFor();
  assert.equal(await panel.getByRole("button", { name: "Always allow" }).count(), 0);
  await panel.getByRole("button", { name: "Allow for this chat" }).click();
  assert.equal((await remote).title, "Coddy fixture");
  await waitFor("the tab in the remote chat's group", () =>
    coddy.state.tabs.find((t) => t.id === mineTab && t.sessionId === "laptop/sess_trip"),
  );

  // release hands the tab back to the shared group; Disconnect on the
  // settings page stops everything, and the panel has no Stop of its own.
  assert.deepEqual(await coddy.command("release", {}), { released: 1 });
  await waitFor("the opened tab in the shared group", () => coddy.state.tabs.find((t) => t.id === opened.tabId && !t.sessionId));
  assert.equal(await panel.locator("#stop-all, #status").count(), 0);
  await options.getByRole("button", { name: "Disconnect" }).click();
  await waitFor("browser/stop", () => coddy.state.stops === 1);
  await waitFor("no tab shared", () => coddy.state.tabs.length === 0);
  await options.getByRole("button", { name: "Save and connect" }).click();
  await options.locator("#status").getByText("Connected", { exact: true }).waitFor({ timeout: 15000 });
  await assert.rejects(coddy.command("snapshot", tab), (e) => ["stopped", "not_shared"].includes(e.data?.reason));

  assert.deepEqual(errors, []);
  // The stop took back what the chat of another Coddy was allowed.
  const again = coddy.command("open_tab", { params: { url: coddy.base + "/fixture?again" }, session: laptop });
  again.catch(() => {}); // refused before the assertion below takes it
  await panel.getByText("A chat of another Coddy asks to use this browser").waitFor();
  await panel.getByRole("button", { name: "Decline" }).click();
  await assert.rejects(again, (e) => e.data?.reason === "chat_declined");

  assert.deepEqual(errors, []);
  console.log("PASS: connect, site approval, open_tab, snapshot, click, type, press, hover, screenshot, upload, download, scroll, other chat refused, turnEnded, side panel web UI signed in by its ticket with a turn from the person's tab, a chat of another Coddy asking first, release, Disconnect");
} finally {
  await close();
  await coddy.close();
}
