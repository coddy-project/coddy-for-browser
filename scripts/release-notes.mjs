// Prints the notes of a release: where the version is published and what each
// attached package is. The release workflow writes them; the README says the
// same at length. A store is named only when the release is sent there
// (CWS_PUBLISH, AMO_PUBLISH set to true); CWS_EXTENSION_ID names the Chrome Web
// Store item.
import { fileURLToPath } from "node:url";

export function releaseNotes(version, env = {}) {
  const chrome = `coddy-for-browser-chrome-${version}.zip`;
  const firefox = `coddy-for-browser-firefox-${version}.zip`;
  const stores = [
    env.CWS_PUBLISH === "true" &&
      env.CWS_EXTENSION_ID &&
      `- **Chrome, Yandex Browser:** [Chrome Web Store](https://chromewebstore.google.com/detail/${env.CWS_EXTENSION_ID})`,
    env.AMO_PUBLISH === "true" && "- **Firefox:** [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/coddy-for-browser/)",
  ].filter(Boolean);
  const published = stores.length ? `\nThe stores publish this version once their review passes:\n\n${stores.join("\n")}\n` : "";
  return `Coddy for Browser ${version}: the extension that lets your own Coddy work in your browser.
${published}
| Package | Browsers |
| --- | --- |
| \`${chrome}\` | Chrome, Yandex Browser and other Chromium browsers |
| \`${firefox}\` | Firefox 140 and later, Firefox for Android 142 and later; unsigned |

**Chrome, Yandex Browser, from the package.** Unpack \`${chrome}\` into a folder you keep, open \`chrome://extensions\` (\`browser://extensions\` in Yandex Browser), turn on Developer mode, press Load unpacked and choose the folder.

**Firefox, from the package.** Open \`about:debugging#/runtime/this-firefox\`, press Load Temporary Add-on and choose \`${firefox}\`; Firefox removes a temporary add-on when it closes. Firefox Developer Edition and Nightly keep it installed from \`about:addons\` (Install Add-on From File) once \`xpinstall.signatures.required\` is \`false\` in \`about:config\`.

Then connect it to your \`coddy serve\` in the extension's settings: https://coddy.dev/docs/features/browser
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) throw new Error("usage: release-notes.mjs <version>");
  process.stdout.write(releaseNotes(version, process.env));
}
