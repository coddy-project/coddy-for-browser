import test from "node:test";
import assert from "node:assert/strict";
import { frameURL, listen, themeOf, PANEL_SOURCE, WEBUI_SOURCE, textOn } from "../src/frame.js";

const theme = {
  scheme: "dark",
  bg: "rgb(15, 15, 16)",
  surface: "rgba(14, 14, 18, 0.62)",
  border: "rgba(255, 255, 255, 0.12)",
  text: "rgb(255, 255, 255)",
  muted: "rgb(156, 163, 175)",
  accent: "rgb(147, 51, 234)",
};

test("the frame's address carries the ticket and the panel's origin", () => {
  const url = new URL(frameURL("http://127.0.0.1:12345/", "t".repeat(64), "chrome-extension://abc"));
  assert.equal(url.searchParams.get("coddy_panel"), "t".repeat(64));
  assert.equal(url.searchParams.get("coddy_panel_origin"), "chrome-extension://abc");
});

test("a theme is taken as plain colours only", () => {
  assert.deepEqual(themeOf(theme), theme);
  assert.equal(themeOf({ ...theme, bg: "url(https://evil.example/x)" }), null);
  assert.equal(themeOf({ ...theme, text: "red; background: url(x)" }), null);
  assert.equal(themeOf({ ...theme, scheme: "neon" }), null);
  assert.equal(themeOf({ ...theme, muted: undefined }), null);
});

function fakeTarget() {
  const target = new EventTarget();
  const frame = { posted: [], postMessage(m, o) { this.posted.push([m, o]); } };
  const deliver = (data, origin = "http://127.0.0.1:12345", source = frame) =>
    target.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
  return { target, frame, deliver };
}

test("the panel answers the web UI at its origin alone", async () => {
  const { target, frame, deliver } = fakeTarget();
  const themes = [];
  listen(target, {
    frame: () => frame,
    origin: () => "http://127.0.0.1:12345",
    onTurn: async ({ sessionId }) => ({ browser_id: "b", tab_id: 3, sessionId }),
    onTheme: (t) => themes.push(t),
  });
  deliver({ source: WEBUI_SOURCE, type: "theme", theme });
  deliver({ source: WEBUI_SOURCE, type: "theme", theme }, "https://evil.example");
  deliver({ source: WEBUI_SOURCE, type: "theme", theme }, "http://127.0.0.1:12345", {});
  assert.equal(themes.length, 1);
  deliver({ source: WEBUI_SOURCE, type: "turn", requestId: "r1", sessionId: "sess_1" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(frame.posted.length, 1);
  const [answer, origin] = frame.posted[0];
  assert.equal(origin, "http://127.0.0.1:12345");
  assert.equal(answer.source, PANEL_SOURCE);
  assert.equal(answer.requestId, "r1");
  assert.equal(answer.tab.tab_id, 3);
});

test("the text on an accent button is the one that reads better on it", () => {
  // The web UI's dark accent and its colour-mix form take white text.
  assert.equal(textOn("rgb(147, 51, 234)"), "#ffffff");
  assert.equal(textOn("color(srgb 0.58 0.2 0.92)"), "#ffffff");
  // A light accent takes the dark one.
  assert.equal(textOn("rgb(167, 139, 250)"), "#15121f");
  assert.equal(textOn("rgba(255, 255, 255, 1)"), "#15121f");
  // Anything that is not a computed colour is refused.
  assert.equal(textOn("url(x)"), null);
  assert.equal(textOn(""), null);
});
