// Uploads the Chrome package of a release to the extension's item in the
// Chrome Web Store and submits it for review, through the Chrome Web Store
// API v2. The store publishes the version once it passes review.
//
//   node scripts/publish-chrome.mjs dist/coddy-for-browser-chrome-<version>.zip <version>
//
// Given the version, a run first asks the store about it and stops when that
// version is already in review or published, so the release job that failed
// can be run again alone. A package uploaded while its submission failed is
// uploaded once more and submitted.
//
// The item has to exist: the first version is uploaded by hand in the
// developer dashboard, with its store listing and privacy tabs filled in.
// Credentials come from the environment (CONTRIBUTING.md, Releases): an
// OAuth client and its refresh token for the scope
// https://www.googleapis.com/auth/chromewebstore,
// the publisher id and the extension id. Without them the script says what is
// missing and exits successfully, so a release without the store still goes
// out.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CHROME_KEYS = ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_PUBLISHER_ID", "CWS_EXTENSION_ID"];
const API = "https://chromewebstore.googleapis.com";
// SUBMITTED are the states of a revision the store already took.
const SUBMITTED = new Set(["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS"]);

async function answer(res, what) {
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}: ${body.error?.message || body.error_description || body.raw || text}`);
  return body;
}

export async function publishChrome({ fetch, env, zip, version, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  const missing = CHROME_KEYS.filter((k) => !env[k]);
  if (missing.length) {
    log(`Chrome Web Store: skipped, set ${missing.join(", ")} to publish there`);
    return null;
  }
  const token = await answer(
    await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.CWS_CLIENT_ID,
        client_secret: env.CWS_CLIENT_SECRET,
        refresh_token: env.CWS_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }).toString(),
    }),
    "access token",
  );
  const auth = { Authorization: `Bearer ${token.access_token}` };
  const item = `publishers/${encodeURIComponent(env.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(env.CWS_EXTENSION_ID)}`;

  if (version) {
    const status = await answer(await fetch(`${API}/v2/${item}:fetchStatus`, { headers: auth }), "status");
    for (const rev of [status.submittedItemRevisionStatus, status.publishedItemRevisionStatus]) {
      if (rev && SUBMITTED.has(rev.state) && (rev.distributionChannels || []).some((c) => c.crxVersion === version)) {
        log(`Chrome Web Store: version ${version} is already ${rev.state}, nothing to do`);
        return { state: rev.state, already: true };
      }
    }
  }

  const upload = await answer(
    await fetch(`${API}/upload/v2/${item}:upload`, { method: "POST", headers: { ...auth, "Content-Type": "application/zip" }, body: zip }),
    "upload",
  );
  let state = upload.uploadState;
  // A large package is processed after the request returns; the store says so
  // and fetchStatus reports the outcome.
  for (let i = 0; state === "IN_PROGRESS" && i < 60; i++) {
    await sleep(5000);
    state = (await answer(await fetch(`${API}/v2/${item}:fetchStatus`, { headers: auth }), "upload status")).lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`upload: the store reports ${state || "no state"}`);
  log(`Chrome Web Store: uploaded${upload.crxVersion ? " version " + upload.crxVersion : ""}`);

  const published = await answer(
    await fetch(`${API}/v2/${item}:publish`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" }),
    "publish",
  );
  log(`Chrome Web Store: submitted, ${published.state || "state unknown"}`);
  return published;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: publish-chrome.mjs <package.zip> [version]");
  await publishChrome({ fetch, env: process.env, zip: await fs.readFile(file), version: process.argv[3] });
}
