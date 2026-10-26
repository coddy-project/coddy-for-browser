// pageAction is serialized by chrome.scripting.executeScript and runs in the
// page's isolated world. Keep every helper inside it, and never accept
// JavaScript source from a page or from Coddy.
export function pageAction(action, params) {
  if (!params.expected_origin || location.origin !== params.expected_origin)
    throw new Error("The page changed before the action; take a new snapshot");
  const state = (globalThis.__coddyPageState ||= { refs: new Map(), nonce: "" });
  const visible = (e) => {
    if (!e.getClientRects().length) return false;
    const style = getComputedStyle(e);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const element = () => {
    const e = state.refs.get(params.ref);
    if (!e || !e.isConnected) throw new Error("The element is gone; take a new snapshot");
    return e;
  };
  const viewport = () => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio });

  if (action === "viewport") return viewport();

  if (action === "snapshot") {
    state.refs.clear();
    state.nonce = crypto.randomUUID().slice(0, 8);
    const items = [];
    const selector =
      'a[href],button,input,textarea,select,summary,[role],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
    const secret = (e) =>
      e instanceof HTMLInputElement &&
      (e.type === "password" || e.type === "hidden" || /one-time-code|cc-/.test(e.autocomplete || ""));
    const nameOf = (e) =>
      (
        e.getAttribute("aria-label") ||
        e.labels?.[0]?.innerText ||
        e.getAttribute("alt") ||
        e.getAttribute("title") ||
        e.innerText ||
        e.getAttribute("placeholder") ||
        e.getAttribute("name") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    const walk = (root) => {
      for (const e of root.querySelectorAll("*")) {
        if (items.length >= 500) return;
        if (e.shadowRoot) walk(e.shadowRoot);
        if (!e.matches(selector) || !visible(e)) continue;
        const ref = `${state.nonce}:${items.length + 1}`;
        state.refs.set(ref, e);
        const rect = e.getBoundingClientRect();
        const item = {
          ref,
          tag: e.tagName.toLowerCase(),
          name: nameOf(e),
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
        const role = e.getAttribute("role");
        if (role) item.role = role;
        if (e.type && typeof e.type === "string" && e.tagName !== "BUTTON") item.type = e.type;
        if (e instanceof HTMLAnchorElement) item.href = e.href.slice(0, 500);
        if (!secret(e) && typeof e.value === "string" && e.value) item.value = e.value.slice(0, 200);
        if (secret(e) && e.value) item.value = "(hidden)";
        if (e.checked) item.checked = true;
        if (e.disabled) item.disabled = true;
        if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) item.offscreen = true;
        items.push(item);
      }
    };
    walk(document);
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").slice(0, 20000),
      elements: items,
      viewport: viewport(),
    };
  }

  if (action === "target") {
    const e = element();
    e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (params.focus) e.focus();
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }

  if (action === "upload_file") {
    const e = element();
    if (!(e instanceof HTMLInputElement) || e.type !== "file")
      throw new Error("upload_file needs the ref of a file input from snapshot");
    const bytes = Uint8Array.from(atob(params.base64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], params.filename));
    e.files = transfer.files;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return { filename: params.filename, bytes: bytes.length };
  }

  throw new Error("Unsupported page action");
}
