import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { asksForSites, requestAccess, hasAccess, EVERY_SITE } from "../src/access.js";
import { manifests } from "../scripts/build.mjs";

const base = JSON.parse(await fs.readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));

// fakeBrowser answers getManifest with one family's manifest and keeps the
// origins it granted, the way permissions.contains and request see them.
function fakeBrowser(manifest, granted = []) {
  const calls = [];
  const have = new Set(granted);
  return {
    calls,
    runtime: { getManifest: () => manifest },
    permissions: {
      async request({ origins }) {
        calls.push(["request", origins]);
        for (const o of origins) have.add(o);
        return true;
      },
      async contains({ origins }) {
        calls.push(["contains", origins]);
        return origins.every((o) => have.has(o));
      },
    },
  };
}

test("Chrome asks for a website when the person allows it, and knows what it granted", async () => {
  const chrome = fakeBrowser(manifests(base, "1").chrome);
  assert.equal(asksForSites(chrome), true);
  assert.equal(await hasAccess(chrome, "https://example.com"), false);
  assert.equal(await requestAccess(chrome, ["https://example.com:443/*"]), true);
  assert.equal(await hasAccess(chrome, "https://example.com"), true);
  assert.deepEqual(chrome.calls[1], ["request", ["https://example.com:443/*"]]);
  await requestAccess(chrome, EVERY_SITE);
  assert.deepEqual(chrome.calls.at(-1), ["request", ["http://*/*", "https://*/*"]]);
});

test("the Firefox build holds every website from the install and asks nothing", async () => {
  const firefox = fakeBrowser(manifests(base, "1").firefox);
  assert.equal(asksForSites(firefox), false);
  assert.equal(await requestAccess(firefox, ["https://example.com:443/*"]), true);
  assert.equal(await hasAccess(firefox, "https://example.com"), true);
  assert.deepEqual(firefox.calls, []);
});

test("a browser that cannot tell keeps the extension out", async () => {
  const chrome = fakeBrowser(manifests(base, "1").chrome);
  chrome.permissions.contains = async () => {
    throw new Error("Invalid value for origin pattern");
  };
  assert.equal(await hasAccess(chrome, "https://example.com"), false);
});
