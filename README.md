# Coddy for Browser

A Chrome extension that lets your own [Coddy](https://github.com/coddy-project/coddy-agent) agent work in the
browser you use every day. Chat with Coddy in the side panel next to the page, or let a chat anywhere else in Coddy -
the web UI, the console, Telegram, a scheduled job - use your browser: it opens a tab, reads the page, clicks, types,
takes screenshots and moves files, and the extension does it in the tabs you share.

[Русская версия](README.ru.md)

The extension talks only to the Coddy server you point it at. The model runs on that server; the extension
executes the actions and asks you before Coddy touches a new website.

## How it works

```
 Coddy chat --> browser tool --> coddy serve  <==== WebSocket (JSON-RPC 2.0) ====  Coddy for Browser
                                 browser listener      opened by the extension        (this extension)
                                 :12348                                                     |
                                                                                            v
                                                                          your tabs in the Coddy tab groups
```

- **The extension dials out.** It opens one WebSocket to the browser listener of `coddy serve` and keeps it open.
  Coddy's actions travel down that socket as requests the extension answers, so Coddy reaches a browser it has no
  route to: a laptop behind NAT works the same as a browser on the server itself.
- **A chat beside the page.** The toolbar button opens the side panel: a chat with your Coddy. The tab you write
  from goes into that chat's tab group, so "summarize this page" or "fill this form" works on the page in front of
  you. Coddy asks in the panel before a tool with side effects runs, and the chat is an ordinary Coddy session you
  can continue in the web UI.
- **Tab groups decide what Coddy reaches.** Coddy sees only the tabs in its Chrome tab groups. You share a tab with
  every chat by pressing **Share** in the side panel, or by dragging it into the **Coddy** group. A chat that works in
  a shared tab moves it into a group of its own, titled after the chat, and no other chat may act there. A tab Coddy
  opens starts in the chat's group. Drag a tab out of a group, or press **Take back**, to take it back.
- **You approve websites.** Before the first action on a website, a small window of the extension asks: allow for
  this chat, always allow, or decline. A page cannot answer that question for you.
- **You can stop it.** The stop button in the side panel's header, or the Stop button on the page Coddy works in,
  cancels every action and ungroups every tab; the tabs stay open.

The wire protocol is documented in Coddy: [Browser protocol](https://coddy.dev/docs/reference/browser-protocol). The feature
from Coddy's side, with its configuration, is [Coddy for Browser](https://coddy.dev/docs/features/browser).

## Requirements

- Chrome 116 or newer. Other Chromium browsers may load it, but only Chrome is tested.
- `coddy serve` built with the `browser` tag. The release binaries, the Docker image and the packages carry it.
- The browser listener turned on in Coddy's `config.yaml`, with a key of at least 32 characters:

  ```yaml
  browser:
    enable: true
    host: 127.0.0.1
    port: 12348
    token: ${CODDY_BROWSER_KEY}
  ```

  Generate the key with `openssl rand -hex 32` and keep it in `<home>/.env` as `CODDY_BROWSER_KEY`. For a server on
  another machine, bind the listener to a reachable address and give it `cert_file` and `key_file`, or put it behind
  an HTTPS reverse proxy that passes WebSocket upgrades: the extension uses plain HTTP only for `localhost`,
  `127.0.0.1` and `[::1]`.

## Install

From a release:

1. Download `coddy-for-browser-<version>.zip` from [Releases](https://github.com/coddy-project/coddy-for-browser/releases)
   and unpack it into a folder you keep.
2. Open `chrome://extensions`, turn on **Developer mode** and press **Load unpacked**. Choose the unpacked folder.

From source (Node.js 22 or newer, no packages to install):

```bash
npm run build
```

Then load `dist/chrome` the same way.

## Connect

The settings page opens after the install, and later from the settings button of the side panel. Enter the listener
address (`http://127.0.0.1:12348` for a local server), the key and a name for this browser, such as
`Chrome - laptop`, then press **Save and connect**. The name tells browsers apart when several are connected to one
server: a chat lists them and selects one.

## Use it

Press the toolbar button and write in the side panel, on the page you want Coddy to work with:

> Summarize this page and list the deadlines it mentions.

The panel shows the answer as it streams, the tool calls as they run, and the questions Coddy asks: allow a tool,
pick an answer. The clock button lists the chats of the panel, the plus starts a new one.

From any other chat of Coddy, share a tab or let Coddy open one, and ask:

> Open the pull request list of coddy-project/coddy-agent and tell me which ones wait for review.

The chat calls the `browser` tool: it lists the tabs it may reach, reads a page as text with element references,
clicks and types through Chrome's debugger, so the input is trusted like a person's, and attaches screenshots when
its model reads images. While Coddy works in a tab, the tab glows and shows a Stop button, and the chat's group title
starts with an hourglass.

## Permissions

| Permission | Why |
| --- | --- |
| `tabs`, `tabGroups` | Read the tabs in the Coddy groups, open and group tabs for a chat. |
| `scripting` | Read a page and resolve element references; show the working indicator. |
| `debugger` | Trusted clicks, typing and keys, and screenshots through the DevTools protocol. Chrome shows a bar while it is attached; the extension detaches 20 s after the last action. |
| `storage` | The connection settings and the websites you allowed. The key is readable only by the extension's own pages. |
| `alarms` | Wake the service worker to reconnect after Chrome stopped it. |
| `notifications` | Tell you that Coddy asks to use a website. |
| `sidePanel` | The chat beside the page. |
| `http://*/*`, `https://*/*` | Act on the websites you allow, and reach your Coddy server. |

The extension sends nothing anywhere but your Coddy server. Pages Coddy reads still reach the model provider your
Coddy server is configured with.

## Develop

```bash
npm test                      # unit tests, Node only
npm run build                 # dist/chrome and dist/coddy-for-browser-<version>.zip
npm i --no-save playwright    # once, for the end-to-end run
npx playwright install chromium
npm run e2e                   # the built extension in a real Chromium against a mock of Coddy
```

`CODDY_BROWSER_PATH` points the end-to-end run at an installed Chromium instead of Playwright's,
`CODDY_SCREENSHOT_DIR` collects screenshots of the extension's pages.

| File | What it does |
| --- | --- |
| `src/background.js` | The service worker: wiring, the messages of the side panel, the approval window and the settings page. |
| `src/panel.js`, `src/chat.js`, `src/md.js` | The side panel's chat, its bridge to Coddy's `chat/*` methods, the Markdown it renders as DOM nodes. |
| `src/connection.js` | The WebSocket, `initialize`, keepalive and reconnects. |
| `src/rpc.js` | The JSON-RPC 2.0 peer. |
| `src/commands.js` | Every action Coddy asks for, with the checks before it. |
| `src/groups.js` | The Coddy tab groups and who holds which tab. |
| `src/approvals.js`, `src/policy.js` | Website approvals and address checks. |
| `src/page.js`, `src/input.js`, `src/indicator.js` | What runs in a page, the DevTools protocol input, the working indicator. |

A change to the protocol goes to both repositories: the extension and `external/browser` in coddy-agent, with the
protocol page updated in the same change.

## License

MIT, see [LICENSE](LICENSE).
