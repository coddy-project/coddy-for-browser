// Prints the notes of a release: what each attached package is and how to
// install it. The release workflow writes them; the README says the same at
// length.
const version = process.argv[2];
if (!version) throw new Error("usage: release-notes.mjs <version>");
const chrome = `coddy-for-browser-chrome-${version}.zip`;
const firefoxZip = `coddy-for-browser-firefox-${version}.zip`;
const firefoxXpi = `coddy-for-browser-firefox-${version}.xpi`;
process.stdout.write(`Coddy for Browser ${version}: the extension that lets your own Coddy work in your browser.

| Package | Browsers |
| --- | --- |
| \`${chrome}\` | Chrome, Yandex Browser and other Chromium browsers |
| \`${firefoxXpi}\` | Firefox 139 and later, signed by Mozilla (attached when the release was signed) |
| \`${firefoxZip}\` | Firefox 139 and later, unsigned: a temporary add-on, or Firefox Developer Edition and Nightly |

**Chrome, Yandex Browser.** Unpack \`${chrome}\` into a folder you keep, open \`chrome://extensions\` (\`browser://extensions\` in Yandex Browser), turn on Developer mode, press Load unpacked and choose the folder.

**Firefox.** Open \`${firefoxXpi}\` in Firefox, or drop it onto \`about:addons\`, and confirm. Without the signed file: open \`about:debugging#/runtime/this-firefox\`, press Load Temporary Add-on and choose \`${firefoxZip}\`; Firefox removes a temporary add-on when it closes. Firefox Developer Edition and Nightly keep the unsigned archive installed from \`about:addons\` (Install Add-on From File) once \`xpinstall.signatures.required\` is \`false\` in \`about:config\`.

Then connect it to your \`coddy serve\` in the extension's settings: https://coddy.dev/docs/features/browser
`);
