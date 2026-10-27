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
    // One image pixel per CSS pixel, as with the debugger: captureTab takes
    // the page's devicePixelRatio back out.
    async screenshot(tabId, view) {
      const dataUrl = await api.tabs.captureTab(tabId, { format: "png", scale: 1 / (view?.scale || 1) });
      return { dataUrl, width: view?.width, height: view?.height };
    },
    history: null,
    go: null,
    detachAll: async () => {},
  };
}
