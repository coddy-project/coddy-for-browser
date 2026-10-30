// Starts a Chromium-family browser with the built extension for the
// end-to-end runs.
//
// Playwright's own Chromium loads an unpacked extension from the command line
// (--load-extension). Branded browsers built on recent Chromium - Google
// Chrome 137 and later, Yandex Browser - ignore that switch, so for a browser
// named by CODDY_BROWSER_PATH the extension is installed through the
// DevTools protocol instead (Extensions.loadUnpacked, which answers only over
// --remote-debugging-pipe), and Playwright attaches to the running browser.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function launchChromium(chromium, extension, { env = process.env, args = [] } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "coddy-for-browser-"));
  const browserEnv = { ...env, LANG: "en_US.UTF-8", LANGUAGE: "en" };
  const executable = env.CODDY_BROWSER_PATH;
  if (!executable) {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      locale: "en-US",
      // Chromium on Linux takes the language of its own controls from LANG.
      env: browserEnv,
      channel: "chromium",
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--lang=en-US", ...args],
    });
    return { context, close: () => close(context, null, profile) };
  }
  const child = spawn(
    executable,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=en-US",
      ...args,
      "about:blank",
    ],
    { env: browserEnv, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const id = await loadUnpacked(child, extension);
  const port = await devToolsPort(profile);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  console.log(`loaded the extension ${id} into ${executable}`);
  return { context, id, close: () => close(context, child, profile, browser) };
}

// loadUnpacked sends Extensions.loadUnpacked over the browser's pipe: one
// JSON message per NUL-terminated frame on fd 3, the answers on fd 4.
function loadUnpacked(child, extension) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the browser did not answer Extensions.loadUnpacked")), 20000);
    child.stdio[4].on("data", (chunk) => {
      buffer += chunk.toString();
      for (let i; (i = buffer.indexOf("\0")) >= 0; buffer = buffer.slice(i + 1)) {
        const msg = JSON.parse(buffer.slice(0, i));
        if (msg.id !== 1) continue;
        clearTimeout(timer);
        if (msg.error) reject(new Error(`Extensions.loadUnpacked: ${msg.error.message}`));
        else resolve(msg.result.id);
      }
    });
    child.stdio[3].write(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: extension } }) + "\0");
  });
}

async function devToolsPort(profile) {
  for (let i = 0; i < 100; i++) {
    try {
      const [port] = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      if (port) return port;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the browser wrote no DevToolsActivePort");
}

async function close(context, child, profile, browser) {
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  child?.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
