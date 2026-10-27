// The browser's own grant of websites to the extension, which scripting and
// fetch need. Chrome grants this machine's addresses at install and every
// other website at run time, on the person's word in a page of the extension
// (optional_host_permissions), so the store sees no request for every website.
// The Firefox build holds <all_urls> from the install, which tabs.captureTab
// needs, and asks nothing. What Coddy may do is still the extension's own
// approvals (approvals.js); the browser's grant only follows them.

import { accessPatterns } from "./policy.js";

// EVERY_SITE is what the switch for every website asks the browser for.
export const EVERY_SITE = ["http://*/*", "https://*/*"];

// asksForSites says whether the browser grants websites at run time.
export function asksForSites(api) {
  return Boolean(api.runtime.getManifest().optional_host_permissions?.length);
}

// requestAccess asks the browser for the patterns. It is called in the click
// that answers, before anything is awaited: the browser shows its prompt only
// for a person's gesture, and answers at once for what it granted already.
export function requestAccess(api, patterns) {
  if (!asksForSites(api) || !patterns.length) return Promise.resolve(true);
  return api.permissions.request({ origins: patterns });
}

// hasAccess says whether the browser lets the extension into origin.
export async function hasAccess(api, origin) {
  if (!asksForSites(api)) return true;
  return api.permissions.contains({ origins: accessPatterns(origin) }).catch(() => false);
}
