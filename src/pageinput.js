// Input through the page, for a browser without the debugger API (Firefox):
// events dispatched to the element at a point (page.js), and screenshots
// through tabs.captureTab. A page can tell these events from a person's, so
// a site that checks isTrusted ignores them; the result says so.

export function pageInput(api, script) {
  return {
    trusted: false,
    act: (tabId, action, p, expected, guard) => {
      guard?.();
      return script(tabId, "input", { ...p, kind: action, expected_origin: expected?.origin });
    },
    // One image pixel per CSS pixel of the page, as with the debugger.
    // captureTab renders the tab's own size in CSS pixels times its scale,
    // which a zoomed page does not share, nor in Firefox for Android a page
    // laid out wider than the screen (980 pixels without a viewport tag).
    async screenshot(tabId, view) {
      const tab = await api.tabs.get(tabId).catch(() => null);
      const scale = view?.width && tab?.width ? view.width / tab.width : 1;
      const dataUrl = await api.tabs.captureTab(tabId, { format: "png", scale });
      return { dataUrl, width: view?.width, height: view?.height };
    },
    history: null,
    go: null,
    detachAll: async () => {},
  };
}
