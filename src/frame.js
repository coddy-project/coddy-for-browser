// The side panel and the web UI in its frame talk by postMessage. The web UI
// asks for the tab of a turn before it sends one; the panel gives that tab to
// the turn's chat and answers with it. The web UI also tells the panel its
// theme's colours, which the panel's own strip takes, and the panel asks the
// web UI to show the chat that holds the person's tab. A message counts only
// from the frame's own window at the web UI's origin, and goes back only to
// that origin.

export const PANEL_SOURCE = "coddy-for-browser";
export const WEBUI_SOURCE = "coddy-web-ui";

// HOME_SESSION is a chat of the connected server. A chat of another Coddy
// process is "<node>/<session id>", which the server's web UI cannot open.
const HOME_SESSION = /^sess_[A-Za-z0-9_-]{1,128}$/;

export function homeSession(id) {
  return typeof id === "string" && HOME_SESSION.test(id) ? id : "";
}

// frameURL is the address the panel loads: the web UI with the ticket that
// signs it in and the panel's origin, which the web UI answers alone, opened
// on sessionId when it names a chat of that server.
export function frameURL(webUI, ticket, panelOrigin, sessionId = "") {
  const url = new URL(webUI);
  url.searchParams.set("coddy_panel", ticket || "");
  url.searchParams.set("coddy_panel_origin", panelOrigin);
  if (homeSession(sessionId)) url.hash = `#/s/${sessionId}`;
  return url.href;
}

// openChat asks the web UI in the frame to show a chat of its server.
export function openChat(frameWindow, webUIOrigin, sessionId) {
  if (!frameWindow || !webUIOrigin || !homeSession(sessionId)) return false;
  frameWindow.postMessage({ source: PANEL_SOURCE, type: "open", sessionId }, webUIOrigin);
  return true;
}

// COLOUR is the only form a theme colour is taken in: what a browser's
// getComputedStyle answers, rgb() or rgba(), or color(srgb ...) for a colour
// written with color-mix(). Only numbers fit, so nothing but a colour reaches
// the panel's CSS.
const NUMBER = "-?(\\d+\\.?\\d*|\\.\\d+)(e-?\\d+)?";
const COLOUR = new RegExp(
  "^(rgba?\\(\\s*\\d{1,3}(\\.\\d+)?\\s*,\\s*\\d{1,3}(\\.\\d+)?\\s*,\\s*\\d{1,3}(\\.\\d+)?\\s*(,\\s*(0|1|0?\\.\\d+)\\s*)?\\)" +
    `|color\\(srgb(\\s+${NUMBER}){3}(\\s*\\/\\s*${NUMBER}%?)?\\))$`,
);
const THEME_KEYS = ["bg", "surface", "border", "text", "muted", "accent"];

// themeOf checks a theme the web UI sent: a scheme and plain colours, or null.
export function themeOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const scheme = raw.scheme === "light" ? "light" : raw.scheme === "dark" ? "dark" : null;
  if (!scheme) return null;
  const theme = { scheme };
  for (const key of THEME_KEYS) {
    const v = raw[key];
    if (typeof v !== "string" || !COLOUR.test(v.trim())) return null;
    theme[key] = v.trim();
  }
  return theme;
}

// listen serves the frame's messages: frame() is the frame's window,
// origin() the web UI's origin, onTurn({sessionId, title}) the tab for a turn,
// onTheme(theme) the web UI's colours.
export function listen(target, { frame, origin, onTurn, onTheme = () => {} }) {
  const handler = async (event) => {
    const expected = origin();
    if (!expected || event.source !== frame() || event.origin !== expected) return;
    const msg = event.data;
    if (!msg || msg.source !== WEBUI_SOURCE) return;
    if (msg.type === "theme") {
      const theme = themeOf(msg.theme);
      if (theme) onTheme(theme);
      return;
    }
    if (msg.type !== "turn" || typeof msg.requestId !== "string") return;
    let tab = null;
    let error;
    try {
      tab = await onTurn({ sessionId: String(msg.sessionId || ""), title: String(msg.title || "") });
    } catch (e) {
      error = String(e?.message || e);
    }
    frame()?.postMessage({ source: PANEL_SOURCE, type: "turn", requestId: msg.requestId, tab, error }, expected);
  };
  target.addEventListener("message", handler);
  return () => target.removeEventListener("message", handler);
}
