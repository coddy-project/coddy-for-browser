// The built extension in a real Chromium against a mock of Coddy's HTTP
// server: connect, open a tab with the site approval, read and act on the
// page, files both ways, another chat refused, turnEnded, the side panel's
// web UI signed in by its ticket and a turn sent from it with the person's
// tab, the chat of the tab in front, the interface scale reaching the open
// panel, a chat of another Coddy asking first, Disconnect on the settings page.
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

// buttonLook reads how a question's buttons are painted. They follow the web
// UI's own: the primary one is a tint of the accent with the page's text
// colour on it, never a solid fill, and Decline is not the colour of danger.
const buttonLook = (page) =>
  page.evaluate(() => {
    const css = (el) => getComputedStyle(el);
    const alpha = (c) => Number((c.match(/\/\s*([\d.]+)\)$/) || c.match(/^rgba\(.*,\s*([\d.]+)\)$/) || [0, 1])[1]);
    const card = document.querySelector(".card.approval");
    const primary = card.querySelector("button.primary");
    const reject = card.querySelector("button.reject");
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const danger = css(probe).color;
    probe.remove();
    return {
      tint: alpha(css(primary).backgroundColor) < 0.5,
      text: css(primary).color === css(document.body).color,
      quietDecline: Boolean(reject) && css(reject).color !== danger,
    };
  });
const tinted = { tint: true, text: true, quietDecline: true };

const coddy = await startMockCoddy({ key });
const { context, id: extensionId, close } = await launchChromium(chromium, extension);
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
  // A branded browser runs service workers of its own extensions as well.
  const worker = await waitFor("the extension's service worker", () =>
    context.serviceWorkers().find((w) => !extensionId || w.url().startsWith(`chrome-extension://${extensionId}/`)),
  );
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

  // Sites allowed beforehand: an address with a range of ports goes on the
  // list, and a scheme other than http(s) is refused under the field. The
  // address is this machine's, which Chrome granted at install: another
  // website brings up Chrome's own prompt, which a headless browser never
  // answers (the end of the run checks that nothing is allowed meanwhile).
  await options.locator("#site").fill("localhost:1000-2000");
  await options.getByRole("button", { name: "Add" }).click();
  await options.locator('#allowed span[title="*://localhost:1000-2000"]').getByText("localhost, ports 1000-2000").waitFor();
  await options.locator("#site").fill("ftp://example.com");
  await options.getByRole("button", { name: "Add" }).click();
  await options.locator("#site-error").getByText("Only http and https addresses can be allowed").waitFor();
  // The card keeps one step of 10 px between its blocks and 8 px between the
  // rows of the list; the error sits under its field, closer to it than to
  // the list.
  const gaps = await options.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const rows = [...document.querySelectorAll("#allowed li")].map((li) => li.getBoundingClientRect());
    return {
      description: Math.round(box(".sites-card .switch-field").top - box(".sites-card > p.muted").bottom),
      field: Math.round(box("#add-site").top - box(".sites-card .switch-field").bottom),
      error: Math.round(box("#site-error").top - box("#add-site").bottom),
      list: Math.round(box("#allowed").top - box("#site-error").bottom),
      rows: [...new Set(rows.slice(1).map((r, i) => Math.round(r.top - rows[i].bottom)))],
    };
  });
  assert.deepEqual(gaps, { description: 10, field: 10, error: 6, list: 10, rows: [8] });
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
  assert.deepEqual(await buttonLook(approval), tinted);
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
  // However large the scale, Share stays clear of the settings button: the
  // title gives way first, then the note beside it.
  const stripAtScale = (factor) =>
    waitFor(`the strip at ${factor}`, () => panel.evaluate((f) => document.documentElement.style.getPropertyValue("--scale") === f, String(factor)));
  const share = panel.locator("#tabbar").getByRole("button", { name: "Share" });
  const onTop = () =>
    share.evaluate((b) => {
      const r = b.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
    });
  await panel.setViewportSize({ width: 260, height: 720 });
  const whole = await panel.locator("#tabbar small").evaluate((n) => n.scrollWidth <= n.clientWidth);
  assert.equal(whole, true, "at 100% the title gives way before the note");
  assert.equal(await onTop(), true);
  await options.locator("#scale").selectOption("200");
  await stripAtScale(2);
  await panel.setViewportSize({ width: 320, height: 720 });
  assert.equal(await onTop(), true, "Share at 200% in a narrow panel");
  await panel.setViewportSize({ width: 420, height: 720 });
  await options.locator("#scale").selectOption("100");
  await stripAtScale(1);
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

  // The chat of the tab in front: its name in the strip shows it, and coming to
  // the tab does once the person turns the setting on. A chat already on show
  // is no change of the web UI's address, and the frame is not loaded again.
  const strip = panel.locator("#tabbar");
  const follow = options.getByRole("switch", { name: "Show the chat of the active tab" });
  const switched = (on) => waitFor(`the setting ${on}`, async () => (await follow.getAttribute("aria-checked")) === String(on));
  const shown = (...ids) => waitFor(`the web UI to show ${ids.join(", ")}`, () => coddy.state.shown.join() === ids.join());
  await strip.getByRole("button", { name: 'in "Read this page"' }).click();
  await shown("sess_panel_1");
  await switched(false);
  await page.bringToFront();
  await strip.getByRole("button", { name: 'in "E2E chat"' }).waitFor();
  assert.deepEqual(coddy.state.shown, ["sess_panel_1"], "the chat stays while the setting is off");
  await follow.click();
  await switched(true);
  assert.equal(await options.evaluate(async () => (await chrome.storage.local.get("settings")).settings.followTab), true);
  assert.deepEqual(coddy.state.shown, ["sess_panel_1"], "turning the setting on moves nothing");
  await mine.bringToFront();
  await strip.getByRole("button", { name: 'in "Read this page"' }).waitFor();
  await page.bringToFront();
  await shown("sess_panel_1", "sess_e2e");
  await mine.bringToFront();
  await shown("sess_panel_1", "sess_e2e", "sess_panel_1");
  await page.bringToFront();
  await shown("sess_panel_1", "sess_e2e", "sess_panel_1", "sess_e2e");
  // A new tab and a page outside the groups leave the chat where it is.
  const blank = await context.newPage();
  await strip.getByText("Coddy works with ordinary web pages only.").waitFor();
  await blank.goto(coddy.base + "/fixture?blank");
  await strip.getByText("taken when you send").waitFor();
  assert.equal(coddy.state.shown.at(-1), "sess_e2e");
  assert.equal(coddy.state.signins, 1, "the web UI was not loaded again");
  await follow.click();
  await switched(false);
  await blank.close();
  await mine.bringToFront();
  await panel.bringToFront();
  await strip.getByRole("button", { name: 'in "Read this page"' }).waitFor();

  // Take back ungroups the tab; Share puts it in the shared group.
  await panel.locator("#tabbar").getByRole("button", { name: "Take back" }).click();
  await waitFor("the tab out of every group", () => !coddy.state.tabs.find((t) => t.id === mineTab));
  await panel.locator("#tabbar").getByRole("button", { name: "Share" }).click();
  await waitFor("the tab in the shared group", () => coddy.state.tabs.find((t) => t.id === mineTab && !t.sessionId));
  await panel.locator("#tabbar").getByText("shared").waitFor();

  // The interface scale of the settings page reaches the open panel at once:
  // the strip and the web UI grow, the frame stays where it was and is not
  // loaded again, and a click lands where the web UI is drawn.
  const panelLayout = () =>
    panel.evaluate(() => {
      const frame = document.getElementById("webui").getBoundingClientRect();
      return {
        strip: document.querySelector(".panel-bar").getBoundingClientRect().height,
        frame: { left: frame.left, right: frame.right, bottom: frame.bottom },
        width: innerWidth,
        height: innerHeight,
        scrolls: document.documentElement.scrollHeight > innerHeight,
      };
    });
  const frameFits = (width, factor) =>
    coddy.state.frame && Math.abs(coddy.state.frame.width - width / factor) <= 1 && Math.abs(coddy.state.frame.scale - factor) < 0.01;
  const before = await panelLayout();
  assert.equal(await options.locator("#scale").inputValue(), "100");
  assert.deepEqual(await options.locator("#scale option").allTextContents(), ["50%", "67%", "75%", "80%", "90%", "100%", "110%", "125%", "150%", "175%", "200%"]);
  await waitFor("the web UI at the browser's own size", () => frameFits(before.width, 1));
  await options.locator("#scale").selectOption("150");
  await waitFor("the web UI at 150%", () => frameFits(before.width, 1.5));
  await waitFor("the strip at 150%", async () => Math.abs((await panelLayout()).strip - before.strip * 1.5) <= 2);
  const scaled = await panelLayout();
  assert.deepEqual(scaled.frame, { left: 0, right: scaled.width, bottom: scaled.height }, "the frame still fills the panel");
  assert.equal(scaled.scrolls, false);
  assert.equal(coddy.state.signins, 1, "the web UI was not loaded again");
  await panel.locator("#tabbar").getByText("shared").waitFor();
  // A real click and real keys, past Playwright's own hit test, which a zoomed
  // frame from another process confuses.
  const composer = await webUI.locator("#composer").evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const frameTop = await panel.evaluate(() => document.getElementById("webui").getBoundingClientRect().top);
  await webUI.locator("#composer").fill("");
  await panel.bringToFront();
  await panel.mouse.click(composer.x * 1.5, frameTop + composer.y * 1.5);
  await panel.keyboard.type("At 150%");
  assert.equal(await webUI.locator("#composer").inputValue(), "At 150%");
  await capture(panel, "panel-scaled", [420], { fit: false });
  // The settings page takes the scale too, and the scale outlives the page.
  const heading = () => options.evaluate(() => document.querySelector("h1").getBoundingClientRect().height);
  const larger = await heading();
  await options.reload();
  await options.locator("#status").getByText("Connected", { exact: true }).waitFor({ timeout: 15000 });
  await waitFor("the scale on the page loaded again", async () => (await options.locator("#scale").inputValue()) === "150");
  await waitFor("the page at 150%", async () => (await heading()) === larger);
  const stored = await options.evaluate(async () => (await chrome.storage.local.get("settings")).settings.scale);
  assert.equal(stored, 150);
  // A value off the list is refused, whoever sends it.
  const refused = await options.evaluate(() => chrome.runtime.sendMessage({ type: "setScale", scale: 33 }));
  assert.match(refused.error, /Choose a scale/);
  // Below 100% the web UI gets more room than the panel has on screen.
  await options.locator("#scale").selectOption("50");
  await waitFor("the web UI at 50%", () => frameFits(before.width, 0.5));
  await options.locator("#scale").selectOption("100");
  await waitFor("the web UI back at the browser's own size", () => frameFits(before.width, 1));
  await waitFor("the strip back at the browser's own size", async () => Math.abs((await panelLayout()).strip - before.strip) <= 1);
  assert.ok((await heading()) < larger);
  assert.equal(coddy.state.signins, 1, "the web UI was not loaded again");
  await webUI.locator("#composer").fill("");

  // A chat of another Coddy asks first, in the panel, and the site it
  // reaches asks again for it: "always" covers only the server's own chats.
  const laptop = { id: "laptop/sess_trip", title: "Trip", node: "laptop" };
  const remote = coddy.command("snapshot", { tabId: mineTab, session: laptop });
  await panel.getByText("A chat of another Coddy asks to use this browser").waitFor();
  await panel.getByText('The chat "Trip" runs on laptop').waitFor();
  await capture(panel, "panel-remote-chat", [420], { fit: false });
  // In the panel the colours are the web UI's own theme.
  assert.deepEqual(await buttonLook(panel), tinted);
  // A question taller than the panel scrolls, so its last button, the refusal,
  // can be reached at any scale.
  await options.locator("#scale").selectOption("200");
  await stripAtScale(2);
  await panel.setViewportSize({ width: 420, height: 400 });
  const declineBottom = () => panel.getByRole("button", { name: "Decline" }).evaluate((b) => b.getBoundingClientRect().bottom);
  assert.ok((await declineBottom()) > 400, "the question is taller than the panel");
  await panel.mouse.move(210, 200);
  await panel.mouse.wheel(0, 2000);
  await waitFor("Decline in view", async () => (await declineBottom()) <= 400);
  await panel.setViewportSize({ width: 420, height: 720 });
  await options.locator("#scale").selectOption("100");
  await stripAtScale(1);
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

  // Every website and another website wait for Chrome's own prompt, which a
  // headless browser never answers: neither is allowed meanwhile. They come
  // last, so the open prompt holds up nothing else.
  await options.bringToFront();
  await options.getByRole("switch", { name: "Allow every website without asking" }).click();
  await options.locator("#site").fill("example.com:1000-2000");
  await options.getByRole("button", { name: "Add" }).click();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await options.locator("#all").getAttribute("aria-checked"), "false");
  assert.ok(await options.locator("#all-note").isHidden());
  assert.equal(await options.locator('#allowed span[title="*://example.com:1000-2000"]').count(), 0);

  assert.deepEqual(errors, []);
  console.log("PASS: connect, site approval, open_tab, snapshot, click, type, press, hover, screenshot, upload, download, scroll, other chat refused, turnEnded, side panel web UI signed in by its ticket with a turn from the person's tab, the chat of the tab in front, the interface scale, a chat of another Coddy asking first, release, Disconnect, nothing allowed before Chrome's own prompt");
} finally {
  await close();
  await coddy.close();
}
