// The browser the extension runs in. Chrome has the side panel and the
// debugger; Yandex Browser has the debugger but no side panel, so the panel
// opens in a window of its own; Firefox has a sidebar and tabs.captureTab but
// no debugger, so input goes through the page. Firefox for Android has no
// windows, no sidebar and no tab groups either: the panel and the questions
// open in tabs, and the extension keeps the tab groups itself
// (virtualgroups.js). The Firefox build is Manifest V2: there
// tabs.captureTab works with the <all_urls> permission, while Firefox's
// Manifest V3 lets an extension capture a tab only after the person invoked
// it there, and the background page stays up with the socket.

export const api = globalThis.browser ?? globalThis.chrome;

// action is the toolbar button: action in Manifest V3 (Chrome), browserAction
// in Manifest V2 (the Firefox build).
export const action = api.action ?? api.browserAction;

export function capabilities(a = api) {
  return {
    sidePanel: typeof a.sidePanel?.setPanelBehavior === "function",
    sidebar: typeof a.sidebarAction?.toggle === "function",
    debugger: typeof a.debugger?.attach === "function",
    tabGroups: typeof a.tabGroups?.update === "function",
    windows: typeof a.windows?.create === "function",
  };
}
