# Changelog

Every version that reaches people has a section here, under its number: the release on GitHub shows it as "What
changed" and addons.mozilla.org as the version's release notes. A pull request that changes the extension adds its
lines under the version it raises `package.json` to.

## 0.1.3

- Both READMEs link to the Chrome Web Store and Firefox Add-ons, with store installation as the default. Firefox
  on desktop and Android uses the same listing and package; Android requires a compatible version published on AMO.
- Installation instructions distinguish browser-managed store updates from manual updates of unpacked builds and
  temporary add-ons, and explain why Chrome may wait until a restart to install an update.
- The READMEs include fresh screenshots, a quick start and troubleshooting; developer instructions live in
  CONTRIBUTING.md and CONTRIBUTING.ru.md.
- The Chrome Web Store reviewers have test instructions for trying the extension without a Coddy server.

## 0.1.2

The first version for the stores since 0.1.0; 0.1.1 was a release on GitHub of the same extension.

- Chrome and Yandex Browser: the extension no longer asks for access to every website at install. It holds this
  machine's addresses only, and asks the browser for a website when you allow it - in a question, in the list of the
  settings page, with the switch for every website - and for a Coddy server on another machine when you save its
  address. The browser asks once per website. A website you took back in the browser's site access menu is asked
  about again.
- Firefox for Android 142 and later, from the same package as Firefox. The extension keeps its tab groups itself,
  since Firefox for Android has none; the web UI and the questions about websites open in tabs; Share and Take back
  act on the page you looked at last; a page Coddy clicks in or takes a picture of comes to the front first.
- Firefox 140 or later is required: the data collection permissions of the extension reached Firefox in 140.
- Firefox: a screenshot has one image pixel per CSS pixel of the page on a HiDPI screen and on a zoomed page too.
- The Stop button on a page Coddy works in keeps its size on a page shown zoomed out, as phones show pages made for
  a desktop.
- The README (https://github.com/coddy-project/coddy-for-browser) describes the three setups of a phone: Coddy in
  Termux on the phone, Coddy on another machine behind HTTPS, and the phone as a node of a swarm.
- Every version sent to addons.mozilla.org carries its release notes and notes for Mozilla's reviewers.

## 0.1.0

The first release, for Chrome, Yandex Browser and Firefox.

- The web UI of your Coddy server beside the page: the side panel in Chrome, the sidebar in Firefox, a window of its
  own in Yandex Browser.
- Coddy reaches only the tabs in its tab groups: the tabs you share and the tabs a chat opens, each chat in a group
  of its own.
- A question before Coddy's first action on a website, for the chat or always, and a question before a chat of
  another Coddy process uses the browser.
- Reading pages, clicking, typing, keys, scrolling, screenshots and files both ways, and a Stop button on the page
  Coddy works in.
