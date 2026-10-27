# Contributing to Coddy for Browser

How to build, test and release the extension. What it does and how to use it is in the [README](README.md).

[Русская версия](CONTRIBUTING.ru.md)

## Develop

```bash
npm test                      # unit tests, Node only
npm run build                 # dist/chrome, dist/firefox and their archives
npm ci                        # once: Playwright, Puppeteer and web-ext at the versions package-lock.json pins
npx playwright install chromium
npm run e2e                   # the Chrome build in a real Chromium against a mock of Coddy
npm run e2e:firefox           # the Firefox build in a real Firefox against the same mock
npm run security              # the security checks of CI (needs Docker or the scanners, and npm ci)
```

The icons are rendered from `src/icons/icon-small.svg` (16 and 32 px, the tile fills the icon) and
`src/icons/icon.svg` (48 and 128 px, with the margin the stores ask for) by `npm run icons`, which needs Playwright.

`CODDY_BROWSER_PATH` points the Chromium run at an installed browser instead of Playwright's Chromium - Google Chrome,
Yandex Browser - which gets the extension through the DevTools protocol, since branded browsers ignore
`--load-extension`. `CODDY_FIREFOX_PATH` names the Firefox of the Firefox run. `CODDY_SCREENSHOT_DIR` collects
screenshots of the extension's pages.

The [CI workflow](.github/workflows/ci.yaml) runs the unit tests, builds both packages as artifacts and runs both
end-to-end runs on every push and pull request.

The screenshots of the README live in `docs/screenshots/`, named `<what>-<theme>-<width>.png`; where a picture has
both a `dark` and a `light` file, the README shows the one of the reader's colour scheme.

## Security checks

A pull request is checked before it lands, and `main` once a week as well:

- [security.yaml](.github/workflows/security.yaml) runs `scripts/security-scan.sh`, which is what `npm run security`
  runs on a developer's machine: trivy (vulnerable packages of `package-lock.json`, the development tools included,
  committed secrets, misconfiguration), semgrep (rules for JavaScript, secrets and GitHub Actions over the extension, the
  scripts and the tests), zizmor (the workflows: expressions a pull request controls, unpinned actions, dangerous
  triggers) and `web-ext lint`, the validator addons.mozilla.org runs on every submission, over a fresh Firefox build;
- [codeql.yaml](.github/workflows/codeql.yaml) runs the security queries of CodeQL over the JavaScript and the
  workflows.

The check fails on a trivy finding of HIGH or above, a semgrep finding of WARNING or above, any zizmor finding and a
validator error. `SEC_FAIL_TRIVY`, `SEC_FAIL_SEMGREP`, `SEC_FAIL_ZIZMOR` and `SEC_FAIL_AMO` move those thresholds (the
header of the script lists every knob). The reports land in `dist/security/`, and the findings of trusted runs go to
code scanning. Each scanner runs from its binary on `PATH` or from an image pinned by digest, so a local run needs
Docker or the binaries, and `npm ci` for web-ext. An accepted trivy finding goes into `.trivyignore.yaml` with a
statement and an expiry; a semgrep finding is suppressed where it is, with a `nosemgrep` comment that says why.

A pull request from a fork runs with a read-only token and none of the repository's secrets. Only the release jobs use
the store credentials, and they run on `main`. Every action is pinned to a commit, no checkout keeps credentials in
`.git`, and the tools come from `package-lock.json` without install scripts.

## Releases

Merging a pull request into `main` releases it once the repository variable `RELEASE_ON_MERGE` is `true`; until then a
merge releases nothing. [tag-on-merge.yaml](.github/workflows/tag-on-merge.yaml) tags the merge commit with the next
version: the patch after the newest `X.Y.Z` tag, or the version of `package.json` when that is higher, so a pull request
raises the minor or major version by editing `package.json`. Then [release.yaml](.github/workflows/release.yaml) builds
that version into both manifests, attaches the packages to a GitHub release and submits them to the Chrome Web Store and
addons.mozilla.org where publishing there is switched on; the stores publish the version once their review passes. A
direct push to `main` releases nothing. **Run workflow** on *Tag release on merge* tags the head of `main` and releases
it whatever the variable says, or, with a tag given, releases that tag again.

What changed in a version is its section of [CHANGELOG.md](CHANGELOG.md): the GitHub release shows it as "What
changed" and addons.mozilla.org as the version's release notes. A pull request that changes the extension raises
`package.json` to its version and adds its lines under `## <version>`; the unit tests fail while the version of
`package.json` has no section.

One job builds the packages, and the GitHub release and each store are jobs of their own that take those packages. A
job that failed is run again alone (**Re-run failed jobs**, or that job's own re-run), and a store job skips a version
the store already holds, so a release half done is finished without touching what went through.

Publishing to a store is switched on by the repository variable `CWS_PUBLISH` or `AMO_PUBLISH` set to `true`
(Settings, Secrets and variables, Actions, or `gh variable set AMO_PUBLISH --body true`). While it is not, the job of
that store is skipped, the release goes out without it, and the release notes do not name it. Each store also needs a
one-time setup; until it is done, its job prints what is missing and the release goes out without that store.

- **Chrome Web Store** (`scripts/publish-chrome.mjs`, API v2). Register as a developer, create the item by uploading the
  first package by hand in the developer dashboard, and fill in its store listing and privacy tabs. Then enable the
  Chrome Web Store API in a Google Cloud project, create an OAuth client and get a refresh token for the
  `https://www.googleapis.com/auth/chromewebstore` scope, as
  [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api) shows. The repository needs the
  secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN`, and the variables `CWS_PUBLISHER_ID` (Publisher,
  Settings in the dashboard) and `CWS_EXTENSION_ID` (the item's id). Yandex Browser installs extensions from the
  Chrome Web Store too.
- **addons.mozilla.org** (`scripts/sign.mjs listed`). An API key from the developer hub (Tools, Manage API Keys) goes
  into the secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. The first submission creates the listing with the metadata of
  `amo/metadata.json`; every version carries its release notes from the changelog and the notes for Mozilla's
  reviewers from `amo/approval-notes.txt` (what the add-on does, how to test it without an account, its permissions),
  and leaves the listing as its authors edited it. Mozilla reviews every version before it is public.
  `node scripts/sign.mjs unlisted` signs a build for self-distribution instead; AMO numbers versions across both
  channels, so one version goes to one of them.

## The source

| File | What it does |
| --- | --- |
| `src/background.js` | The background (a service worker in Chrome, a page in Firefox): wiring, the messages of the side panel, the approval window and the settings page. |
| `src/platform.js` | What the browser offers: the side panel, the sidebar, the debugger, windows and tab groups. |
| `src/panel.js`, `src/frame.js` | The side panel: the web UI in a frame, signed in by its ticket, and the bridge that gives a turn its tab and takes the web UI's theme. |
| `src/connection.js` | The WebSocket, `initialize`, keepalive and reconnects. |
| `src/rpc.js` | The JSON-RPC 2.0 peer. |
| `src/commands.js` | Every action Coddy asks for, with the checks before it. |
| `src/groups.js` | The Coddy tab groups and who holds which tab. |
| `src/virtualgroups.js` | Tab groups the extension keeps itself where the browser has none (Firefox for Android). |
| `src/approvals.js`, `src/policy.js` | Website approvals and address checks. |
| `src/access.js` | The browser's own grant of websites: asked for in the click that allows one, checked before an action. |
| `src/page.js`, `src/input.js`, `src/pageinput.js`, `src/indicator.js` | What runs in a page, input through the DevTools protocol (Chrome) or through the page (Firefox), the working indicator. |
| `scripts/build.mjs` | The build of each browser family (the Firefox manifest is Manifest V2). |
| `scripts/next-version.mjs`, `scripts/publish-chrome.mjs`, `scripts/sign.mjs` | The version of the next release, the upload to the Chrome Web Store and the submission to addons.mozilla.org. |
| `scripts/security-scan.sh` | The security checks of CI and of `npm run security`. |

A change to the protocol goes to both repositories: the extension and `external/browser` in coddy-agent, with the
protocol page updated in the same change.
