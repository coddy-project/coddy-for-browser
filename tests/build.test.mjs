import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { manifests, GECKO_ID } from "../scripts/build.mjs";

const base = JSON.parse(await fs.readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));

test("the Chrome build keeps the side panel, the debugger and the service worker", () => {
  const { chrome } = manifests(base, "1.2.3");
  assert.equal(chrome.version, "1.2.3");
  assert.equal(chrome.background.service_worker, "background.js");
  assert.ok(chrome.permissions.includes("debugger") && chrome.permissions.includes("sidePanel"));
  assert.equal(chrome.side_panel.default_path, "panel.html");
});

test("the Chrome build holds this machine's addresses and asks for every other website at run time", () => {
  const { chrome } = manifests(base, "1.2.3");
  assert.deepEqual(chrome.host_permissions, ["*://localhost/*", "*://127.0.0.1/*", "*://[::1]/*"]);
  assert.deepEqual(chrome.optional_host_permissions, ["http://*/*", "https://*/*"]);
  // The store reviews a request for every website at length.
  for (const broad of ["<all_urls>", "*://*/*", "http://*/*", "https://*/*"]) {
    assert.ok(!chrome.host_permissions.includes(broad), broad);
    assert.ok(!chrome.permissions.includes(broad), broad);
  }
});

test("the Firefox build is Manifest V2 with a sidebar, a persistent page and its add-on id, and no Chrome-only keys", () => {
  const { firefox } = manifests(base, "1.2.3");
  assert.equal(firefox.manifest_version, 2);
  assert.deepEqual(firefox.background, { scripts: ["background.js"], type: "module", persistent: true });
  assert.equal(firefox.browser_action.default_title, "Coddy for Browser");
  assert.equal(firefox.action, undefined);
  assert.equal(typeof firefox.content_security_policy, "string");
  assert.ok(!firefox.permissions.includes("debugger") && !firefox.permissions.includes("sidePanel"));
  assert.ok(firefox.permissions.includes("tabGroups"));
  assert.ok(firefox.permissions.includes("<all_urls>"));
  assert.equal(firefox.host_permissions, undefined);
  assert.equal(firefox.optional_host_permissions, undefined);
  // The data collection permissions need Firefox 140. No gecko_android:
  // addons.mozilla.org takes it as a claim of Firefox for Android support,
  // which has neither tab groups nor a sidebar.
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.equal(firefox.browser_specific_settings.gecko_android, undefined);
  assert.equal(firefox.sidebar_action.default_panel, "panel.html");
  assert.equal(firefox.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(firefox.side_panel, undefined);
  assert.equal(firefox.minimum_chrome_version, undefined);
  // The Chrome manifest is not changed by the Firefox one.
  assert.ok(manifests(base, "1").chrome.permissions.includes("debugger"));
});
