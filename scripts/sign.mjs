// Signs the Firefox build at addons.mozilla.org as an unlisted add-on, the
// only kind release Firefox installs from a file, and leaves it as
// dist/coddy-for-browser-firefox-<version>.xpi. The API key comes from
// AMO_JWT_ISSUER and AMO_JWT_SECRET; the release workflow runs it when they
// are set.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const { AMO_JWT_ISSUER: issuer, AMO_JWT_SECRET: secret } = process.env;
if (!issuer || !secret) throw new Error("Set AMO_JWT_ISSUER and AMO_JWT_SECRET, an API key of addons.mozilla.org");

const out = path.join(root, "dist", "signed");
await fs.rm(out, { recursive: true, force: true });
// The secret travels in the environment, not on a command line other users
// of the machine could read.
execFileSync(
  "npx",
  ["--yes", "web-ext@8", "sign", "--channel", "unlisted", "--source-dir", path.join(root, "dist", "firefox"), "--artifacts-dir", out],
  { stdio: "inherit", env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret } },
);
const [xpi] = (await fs.readdir(out)).filter((f) => f.endsWith(".xpi"));
if (!xpi) throw new Error("addons.mozilla.org returned no signed .xpi");
await fs.rename(path.join(out, xpi), path.join(root, "dist", `coddy-for-browser-firefox-${version}.xpi`));
console.log(`signed: dist/coddy-for-browser-firefox-${version}.xpi`);
