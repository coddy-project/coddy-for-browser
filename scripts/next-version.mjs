// Prints the version the next release takes. The first release takes the
// version of package.json; every later one bumps the patch of the newest
// X.Y.Z tag, unless package.json names a higher version, which is how a pull
// request raises the minor or major version. tag-on-merge.yaml runs it on the
// merged commit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(v) {
  const m = VERSION.exec(v);
  return m ? m.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function nextVersion(tags, base) {
  const own = parse(base);
  if (!own) throw new Error(`package.json version must be X.Y.Z, got ${base}`);
  const released = tags.map(parse).filter(Boolean).sort(compare);
  if (!released.length) return base;
  const newest = released[released.length - 1];
  const bumped = [newest[0], newest[1], newest[2] + 1];
  return (compare(own, bumped) > 0 ? own : bumped).join(".");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const tags = execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  process.stdout.write(nextVersion(tags, version) + "\n");
}
