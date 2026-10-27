// indicator is serialized by scripting.executeScript into a tab Coddy
// works in: a glow around the page and a Stop button at the bottom, so the
// user sees which tab the agent drives and can stop it from the page itself.
// It lives in a closed shadow root and passes every pointer event through but
// the button's.
export function indicator(show, label) {
  const id = "coddy-for-browser-indicator";
  const host = document.getElementById(id);
  if (!show) {
    host?.remove();
    return true;
  }
  if (host) {
    host.__coddyLabel && (host.__coddyLabel.textContent = label);
    return true;
  }
  const root = document.createElement("div");
  root.id = id;
  root.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const shadow = root.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .glow { position: fixed; inset: 0; pointer-events: none; border-radius: 6px;
      box-shadow: inset 0 0 0 2px rgba(167,139,250,.95), inset 0 0 24px 4px rgba(139,92,246,.45);
      animation: pulse 2.4s ease-in-out infinite; }
    @keyframes pulse { 50% { box-shadow: inset 0 0 0 2px rgba(167,139,250,.7), inset 0 0 36px 8px rgba(139,92,246,.3); } }
    .pill { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); pointer-events: auto;
      display: flex; gap: 10px; align-items: center; padding: 7px 8px 7px 14px; border-radius: 999px;
      font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f5f3ff;
      background: rgba(16,16,20,.92); box-shadow: 0 6px 24px rgba(0,0,0,.35); }
    button { all: unset; cursor: pointer; padding: 5px 12px; border-radius: 999px; background: #dc2626; color: #fff; font-weight: 600; }
    button:focus-visible { outline: 2px solid #f5f3ff; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .glow { animation: none; } }`;
  const glow = document.createElement("div");
  glow.className = "glow";
  const pill = document.createElement("div");
  pill.className = "pill";
  const text = document.createElement("span");
  text.textContent = label;
  const stop = document.createElement("button");
  stop.textContent = "Stop";
  stop.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    (globalThis.browser ?? globalThis.chrome).runtime.sendMessage({ type: "stop", from: "indicator" });
  });
  pill.append(text, stop);
  shadow.append(style, glow, pill);
  root.__coddyLabel = text;
  document.documentElement.append(root);
  return true;
}
