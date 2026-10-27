// Sends the Firefox build to addons.mozilla.org.
//
//   node scripts/sign.mjs listed     submits the version to the public
//                                    listing, with the metadata of
//                                    amo/metadata.json; Mozilla reviews it and
//                                    publishes it, so nothing comes back here
//   node scripts/sign.mjs unlisted   signs it for self-distribution and leaves
//                                    dist/coddy-for-browser-firefox-<version>.xpi
//
// AMO numbers versions per add-on across both channels, so one version goes
// to one of them. The API key comes from AMO_JWT_ISSUER and AMO_JWT_SECRET;
// without them the script says so and exits successfully, so a release
// without the store still goes out. The build ships its sources as they are
// (no bundler, no minifier), so no source archive is uploaded.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const channel = process.argv[2] || "listed";
if (channel !== "listed" && channel !== "unlisted") throw new Error("usage: sign.mjs [listed|unlisted]");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const { AMO_JWT_ISSUER: issuer, AMO_JWT_SECRET: secret } = process.env;
if (!issuer || !secret) {
  console.log("addons.mozilla.org: skipped, set AMO_JWT_ISSUER and AMO_JWT_SECRET (an API key of addons.mozilla.org) to publish there");
  process.exit(0);
}

const out = path.join(root, "dist", "signed");
await fs.rm(out, { recursive: true, force: true });
const args = ["--yes", "web-ext@8", "sign", "--channel", channel, "--source-dir", path.join(root, "dist", "firefox"), "--artifacts-dir", out];
// A listed version waits for Mozilla's review, which takes longer than a
// workflow should; the submission is enough.
if (channel === "listed") args.push("--amo-metadata", path.join(root, "amo", "metadata.json"), "--approval-timeout", "0");
// The secret travels in the environment, not on a command line other users
// of the machine could read.
execFileSync("npx", args, { stdio: "inherit", env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret } });
if (channel === "listed") {
  console.log(`addons.mozilla.org: version ${version} submitted for review`);
} else {
  const [xpi] = (await fs.readdir(out)).filter((f) => f.endsWith(".xpi"));
  if (!xpi) throw new Error("addons.mozilla.org returned no signed .xpi");
  await fs.rename(path.join(out, xpi), path.join(root, "dist", `coddy-for-browser-firefox-${version}.xpi`));
  console.log(`signed: dist/coddy-for-browser-firefox-${version}.xpi`);
}
