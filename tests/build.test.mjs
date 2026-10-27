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
  assert.equal(firefox.sidebar_action.default_panel, "panel.html");
  assert.equal(firefox.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(firefox.side_panel, undefined);
  assert.equal(firefox.minimum_chrome_version, undefined);
  // The Chrome manifest is not changed by the Firefox one.
  assert.ok(manifests(base, "1").chrome.permissions.includes("debugger"));
});
