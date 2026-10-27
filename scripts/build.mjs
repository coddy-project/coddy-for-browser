// Builds the extension for each browser family and packs the archives a
// release attaches. Node alone, no packages.
//
//   dist/chrome    Chrome, Yandex Browser and other Chromium browsers (the
//                  side panel where the browser has one, a window of its own
//                  where it has not)
//   dist/firefox   Firefox 139 and later, Manifest V2 (the sidebar, input
//                  through the page, screenshots through tabs.captureTab)
//
//   dist/coddy-for-browser-chrome-<version>.zip
//   dist/coddy-for-browser-firefox-<version>.zip   the unsigned Firefox build;
//                  a signed .xpi comes from addons.mozilla.org (sign.mjs)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const src = path.join(root, "src");
const base = JSON.parse(await fs.readFile(path.join(src, "manifest.json"), "utf8"));

// The add-on id Firefox keeps the extension's storage under; the signed
// release carries it too.
export const GECKO_ID = "coddy-for-browser@coddy.dev";

// manifests are the manifest of each family, from the Chrome one in src/.
// The Firefox build is Manifest V2 (platform.js says why).
export function manifests(m, v) {
  const chrome = { ...structuredClone(m), version: v };
  const firefox = structuredClone(chrome);
  firefox.manifest_version = 2;
  delete firefox.minimum_chrome_version;
  delete firefox.side_panel;
  delete firefox.host_permissions;
  delete firefox.optional_host_permissions;
  firefox.browser_action = firefox.action;
  delete firefox.action;
  // A persistent background page, as a module like Chrome's service worker:
  // it holds the socket to Coddy.
  firefox.background = { scripts: ["background.js"], type: "module", persistent: true };
  // No debugger (input goes through the page), and the sidebar is a manifest
  // key, not a permission. <all_urls> lets tabs.captureTab take the
  // screenshot; the extension still acts on http and https pages only
  // (policy.isWebPage).
  firefox.permissions = [...m.permissions.filter((p) => p !== "debugger" && p !== "sidePanel"), "<all_urls>"];
  firefox.content_security_policy = m.content_security_policy.extension_pages;
  firefox.sidebar_action = {
    default_panel: "panel.html",
    default_title: "Coddy",
    default_icon: m.action.default_icon,
    open_at_install: false,
  };
  firefox.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      // Tab groups reached extensions in Firefox 139.
      strict_min_version: "139.0",
      // The extension sends the pages it works on to the Coddy server the
      // user connects it to.
      data_collection_permissions: { required: ["websiteContent", "browsingActivity"] },
    },
  };
  return { chrome, firefox };
}

async function build(name, manifest) {
  const out = path.join(root, "dist", name);
  await fs.rm(out, { recursive: true, force: true });
  await fs.cp(src, out, { recursive: true, filter: (p) => !p.endsWith(".svg") });
  await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const archive = path.join(root, "dist", `coddy-for-browser-${name}-${version}.zip`);
  await zipDirectory(out, archive);
  console.log(`${name}: ${path.relative(root, out)}, ${path.relative(root, archive)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { chrome, firefox } = manifests(base, version);
  await build("chrome", chrome);
  await build("firefox", firefox);
}
