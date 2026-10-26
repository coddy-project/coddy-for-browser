// Connects the built extension in a real Chromium to a real Coddy listener
// and keeps it there until stdin closes, answering every website question
// with "Always allow". coddy-agent's live test runs it to check both sides of
// the protocol against each other:
//
//   CODDY_URL=http://127.0.0.1:12348 CODDY_KEY=... node tests/e2e/drive.mjs
//
// It prints "CONNECTED" once the extension reports Connected. With
// CODDY_PANEL_PAGE and CODDY_PANEL_PROMPT it then opens that page, writes the
// prompt in the side panel from it, allows every tool the panel is asked
// about and prints "ANSWER: <text>" once the answer is in.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extension = path.join(root, "dist", "chrome");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "coddy-for-browser-drive-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  locale: "en-US",
  // Chromium on Linux takes the language of its own controls from LANG.
  env: { ...process.env, LANG: "en_US.UTF-8", LANGUAGE: "en" },
  ...(process.env.CODDY_BROWSER_PATH ? { executablePath: process.env.CODDY_BROWSER_PATH } : { channel: "chromium" }),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--lang=en-US"],
});
const done = async (code) => {
  await context.close().catch(() => {});
  await fs.rm(profile, { recursive: true, force: true });
  process.exit(code);
};
process.stdin.on("end", () => done(0));
process.stdin.resume();
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const origin = worker.url().split("/").slice(0, 3).join("/");
  context.on("page", async (page) => {
    if (!page.url().startsWith(origin + "/approval.html")) return;
    const allow = page.getByRole("button", { name: "Always allow" });
    while (!page.isClosed()) {
      await allow.click({ timeout: 2000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  const options = await context.newPage();
  await options.goto(origin + "/options.html");
  await options.locator("#address").fill(process.env.CODDY_URL);
  await options.locator("#key").fill(process.env.CODDY_KEY);
  await options.locator("#name").fill(process.env.CODDY_BROWSER_NAME || "Chrome - live test");
  await options.getByRole("button", { name: "Save and connect" }).click();
  await options.locator("#status").getByText("Connected", { exact: true }).waitFor({ timeout: 20000 });
  console.log("CONNECTED");
  if (process.env.CODDY_PANEL_PROMPT) {
    const page = await context.newPage();
    await page.goto(process.env.CODDY_PANEL_PAGE);
    await page.bringToFront();
    const panel = await context.newPage();
    await panel.goto(origin + "/panel.html");
    await panel.getByText("What should Coddy do in this tab?").waitFor();
    await panel.locator("#prompt").fill(process.env.CODDY_PANEL_PROMPT);
    await panel.locator("#prompt").press("Enter");
    const allow = panel.locator(".card.ask button.primary, .card.approval button.primary");
    const answer = panel.locator(".message.assistant");
    for (let i = 0; i < 600 && !(await answer.count()); i++) {
      if (await allow.count()) await allow.first().click().catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
    await panel.locator("#send[title=Send]").waitFor({ timeout: 30000 });
    console.log("ANSWER: " + (await answer.last().innerText()).replace(/\s+/g, " "));
  }
} catch (e) {
  console.error(e);
  await done(1);
}
