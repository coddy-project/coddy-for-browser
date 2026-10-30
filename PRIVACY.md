# Privacy policy of Coddy for Browser

Last updated: 30 October 2026.

Coddy for Browser is a browser extension that connects your browser to a Coddy agent server you run yourself
(`coddy serve`). This policy describes what the extension handles and where it goes.

## Where data goes

The extension talks to one server: the Coddy server whose address you enter on its settings page. It sends nothing to
the developers of Coddy for Browser or to any other party.

To that server it sends:

- the address and title of the tabs in its tab groups (the tabs you share and the tabs a chat opens), and of the tab
  you look at when you write in the side panel;
- when a chat acts in one of those tabs, after you allowed that website: the text of the page with references to its
  elements, screenshots of the visible part of the tab, the files a chat uploads to or downloads from the page, and the
  outcome of each action;
- the name you give this browser and the version of the extension.

What happens to this data next is decided by your Coddy server: it passes page contents to the model provider it is
configured with, like any other tool result. Your Coddy's configuration and its provider's terms apply there.

## What stays on your device

The extension keeps its settings in the browser's extension storage: the server address, the key the server issued,
the browser's name, the interface scale, the websites you allow always, and which tab group belongs to which chat.
Removing the extension removes them.

## What the extension does not do

- It collects no analytics or telemetry and shows no advertising.
- It does not reach tabs outside its tab groups, and it does not act on a website before you allow it. In Chrome and
  Yandex Browser it has no access to any website beyond your own machine until you allow that website in the
  browser's prompt.
- It does not sell or transfer data to third parties, and it does not use data for any purpose other than letting your
  Coddy work in your browser.

## Contact

Questions about this policy: [open an issue](https://github.com/coddy-project/coddy-for-browser/issues).
