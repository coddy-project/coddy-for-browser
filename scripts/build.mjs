// Builds the Chrome extension into dist/chrome and packs it into
// dist/coddy-for-browser-<version>.zip, the archive a release attaches and the
// Chrome Web Store takes. Node alone, no packages.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const src = path.join(root, "src");
const out = path.join(root, "dist", "chrome");

await fs.rm(out, { recursive: true, force: true });
await fs.cp(src, out, { recursive: true, filter: (p) => !p.endsWith(".svg") });
const manifest = JSON.parse(await fs.readFile(path.join(src, "manifest.json"), "utf8"));
manifest.version = version;
await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const archive = path.join(root, "dist", `coddy-for-browser-${version}.zip`);
await zipDirectory(out, archive);
console.log(`chrome: ${path.relative(root, out)}`);
console.log(`archive: ${path.relative(root, archive)}`);
