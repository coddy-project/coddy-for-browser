// Prints the notes of a release: where the version is published and what each
// attached package is. The release workflow writes them; the README says the
// same at length. CWS_EXTENSION_ID, when set, names the Chrome Web Store item.
const version = process.argv[2];
if (!version) throw new Error("usage: release-notes.mjs <version>");
const chrome = `coddy-for-browser-chrome-${version}.zip`;
const firefox = `coddy-for-browser-firefox-${version}.zip`;
const cws = process.env.CWS_EXTENSION_ID ? `https://chromewebstore.google.com/detail/${process.env.CWS_EXTENSION_ID}` : "";
const amo = "https://addons.mozilla.org/firefox/addon/coddy-for-browser/";
const stores = [
  cws && `- **Chrome, Yandex Browser:** [Chrome Web Store](${cws})`,
  `- **Firefox:** [addons.mozilla.org](${amo})`,
]
  .filter(Boolean)
  .join("\n");
process.stdout.write(`Coddy for Browser ${version}: the extension that lets your own Coddy work in your browser.

The stores publish this version once their review passes:

${stores}

| Package | Browsers |
| --- | --- |
| \`${chrome}\` | Chrome, Yandex Browser and other Chromium browsers |
| \`${firefox}\` | Firefox 139 and later, unsigned |

**Chrome, Yandex Browser, from the package.** Unpack \`${chrome}\` into a folder you keep, open \`chrome://extensions\` (\`browser://extensions\` in Yandex Browser), turn on Developer mode, press Load unpacked and choose the folder.

**Firefox, from the package.** Open \`about:debugging#/runtime/this-firefox\`, press Load Temporary Add-on and choose \`${firefox}\`; Firefox removes a temporary add-on when it closes. Firefox Developer Edition and Nightly keep it installed from \`about:addons\` (Install Add-on From File) once \`xpinstall.signatures.required\` is \`false\` in \`about:config\`.

Then connect it to your \`coddy serve\` in the extension's settings: https://coddy.dev/docs/features/browser
`);
