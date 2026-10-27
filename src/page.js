// pageAction is serialized by scripting.executeScript and runs in the page's
// isolated world. Keep every helper inside it, and never accept JavaScript
// source from a page or from Coddy.
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

  // deepAt is the element at a viewport point, inside same-origin frames;
  // crossOrigin says the point lies in a frame of another website, which the
  // approval of this page does not cover.
  const deepAt = (x, y) => {
    let doc = document;
    let px = x;
    let py = y;
    for (let depth = 0; depth < 10; depth++) {
      const e = doc.elementFromPoint(px, py);
      if (!e) return { element: null };
      if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(e.tagName)) {
        let inner = null;
        try {
          inner = e.contentDocument;
        } catch {}
        if (!inner) return { element: e, crossOrigin: true };
        const r = e.getBoundingClientRect();
        px -= r.left + (e.clientLeft || 0);
        py -= r.top + (e.clientTop || 0);
        doc = inner;
        continue;
      }
      return { element: e };
    }
    return { element: null };
  };
  const focusedDeep = () => {
    let e = document.activeElement;
    for (let depth = 0; depth < 10 && e && /^(IFRAME|FRAME)$/.test(e.tagName); depth++) {
      let inner = null;
      try {
        inner = e.contentDocument;
      } catch {}
      if (!inner) return { element: e, crossOrigin: true };
      e = inner.activeElement;
    }
    return { element: e };
  };

  if (action === "hit") {
    for (const p of params.points || []) if (deepAt(p.x, p.y).crossOrigin) return { crossOrigin: true };
    if (params.focus && focusedDeep().crossOrigin) return { crossOrigin: true };
    return { crossOrigin: false };
  }

  // input is input through the page, where the browser has no debugger API
  // (Firefox): events dispatched to the element at a point. A page can tell
  // them from a person's (isTrusted is false), and some sites ignore them.
  if (action === "input") {
    const kind = params.kind;
    const opts = (x, y, extra = {}) => ({ bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, ...extra });
    const at = (x, y) => {
      const hit = deepAt(x, y);
      if (hit.crossOrigin) throw new Error("The point is inside a frame of another website; open its address in a tab of its own");
      if (!hit.element) throw new Error("Nothing is at that point of the page");
      return hit.element;
    };
    const pointer = (e, type, x, y, extra) => {
      const P = globalThis.PointerEvent || MouseEvent;
      e.dispatchEvent(new P(type, opts(x, y, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra })));
    };
    const mouse = (e, type, x, y, extra) => e.dispatchEvent(new MouseEvent(type, opts(x, y, extra)));
    const move = (e, x, y, buttons = 0) => {
      pointer(e, "pointerover", x, y, { buttons });
      // enter events do not bubble: the target and each ancestor get one.
      for (let a = e; a; a = a.parentElement) {
        pointer(a, "pointerenter", x, y, { buttons, bubbles: false });
        mouse(a, "mouseenter", x, y, { buttons, bubbles: false });
      }
      mouse(e, "mouseover", x, y, { buttons });
      pointer(e, "pointermove", x, y, { buttons });
      mouse(e, "mousemove", x, y, { buttons });
    };
    const editable = (e) =>
      e && (e.isContentEditable || e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(e.type)));
    const insert = (target, text) => {
      if (!text) return;
      target?.focus?.();
      // execCommand keeps the page's undo history and fires the input events
      // an editor listens to; a field it cannot reach gets the value set.
      if (document.execCommand("insertText", false, text)) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        target.setRangeText(text, start, end, "end");
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    };
    if (kind === "click") {
      const button = { left: 0, middle: 1, right: 2 }[params.button || "left"];
      if (button === undefined) throw new Error("button is left, right or middle");
      const count = Math.min(Math.max(Number(params.count) || 1, 1), 3);
      const e = at(params.x, params.y);
      move(e, params.x, params.y);
      for (let i = 1; i <= count; i++) {
        pointer(e, "pointerdown", params.x, params.y, { button, buttons: 1 << button, detail: i });
        mouse(e, "mousedown", params.x, params.y, { button, buttons: 1 << button, detail: i });
        if (i === 1 && typeof e.focus === "function") e.focus({ preventScroll: true });
        pointer(e, "pointerup", params.x, params.y, { button, detail: i });
        mouse(e, "mouseup", params.x, params.y, { button, detail: i });
        if (button === 0) mouse(e, "click", params.x, params.y, { button, detail: i });
        else if (button === 1) mouse(e, "auxclick", params.x, params.y, { button, detail: i });
        if (button === 0 && i === 2) mouse(e, "dblclick", params.x, params.y, { button, detail: 2 });
      }
      if (button === 2) mouse(e, "contextmenu", params.x, params.y, { button });
      return { ok: true, trusted: false };
    }
    if (kind === "hover") {
      move(at(params.x, params.y), params.x, params.y);
      return { ok: true, trusted: false };
    }
    if (kind === "type") {
      const { element, crossOrigin } = focusedDeep();
      if (crossOrigin) throw new Error("The focus is inside a frame of another website");
      if (params.clear) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
        else document.execCommand("selectAll");
        if (!document.execCommand("delete") && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          element.value = "";
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        }
      }
      insert(element, String(params.text ?? ""));
      return { ok: true, trusted: false };
    }
    if (kind === "press") {
      const parts = String(params.key || "").split("+").filter(Boolean);
      const name = parts.pop();
      if (!name) throw new Error("press needs a key");
      const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
      for (const m of parts) {
        const k = { Ctrl: "ctrlKey", Control: "ctrlKey", Alt: "altKey", Shift: "shiftKey", Meta: "metaKey", Cmd: "metaKey", Command: "metaKey" }[m];
        if (!k) throw new Error(`Unsupported key modifier ${m}`);
        mods[k] = true;
      }
      const named = ["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space"];
      const char = /^[a-z0-9]$/i.test(name);
      if (!named.includes(name) && !char) throw new Error(`Unsupported key ${name}`);
      const key = name === "Space" ? " " : char && mods.shiftKey ? name.toUpperCase() : name;
      const code = char ? (/^\d$/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`) : name;
      const { element, crossOrigin } = focusedDeep();
      if (crossOrigin) throw new Error("The focus is inside a frame of another website");
      const target = element || document.body;
      const ev = (type) => target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true, ...mods }));
      const go = ev("keydown");
      const shortcut = mods.ctrlKey || mods.metaKey || mods.altKey;
      if (go && (char || name === "Space") && !shortcut) ev("keypress");
      // A dispatched key does nothing by itself; what a person's key would do
      // is done here, unless the page cancelled the key.
      if (go) {
        if (char && shortcut && (mods.ctrlKey || mods.metaKey) && name.toLowerCase() === "a") document.execCommand("selectAll");
        else if ((char || name === "Space") && !shortcut && editable(target)) insert(target, key);
        else if (name === "Space" && target instanceof HTMLElement && /^(BUTTON|SUMMARY)$/.test(target.tagName)) target.click();
        else if (name === "Backspace" && editable(target)) document.execCommand("delete");
        else if (name === "Delete" && editable(target)) document.execCommand("forwardDelete");
        else if (name === "Enter") {
          if (target instanceof HTMLTextAreaElement || target?.isContentEditable) insert(target, "\n");
          else if (target instanceof HTMLInputElement && target.form) target.form.requestSubmit();
          else if (target instanceof HTMLElement && /^(A|BUTTON|SUMMARY)$/.test(target.tagName)) target.click();
        } else if (name === "Tab") {
          const focusable = [...document.querySelectorAll('a[href],button,input,textarea,select,summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])')].filter(
            (e) => !e.disabled && visible(e),
          );
          const i = focusable.indexOf(target);
          const next = focusable[(i + (mods.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
          next?.focus();
        }
      }
      ev("keyup");
      return { ok: true, trusted: false };
    }
    if (kind === "scroll") {
      const dx = Number(params.dx) || 0;
      const dy = Number(params.dy) || 0;
      let e = at(params.x, params.y);
      e.dispatchEvent(new WheelEvent("wheel", opts(params.x, params.y, { deltaX: dx, deltaY: dy, deltaMode: 0 })));
      // The nearest box that can still scroll that way takes it, else the page.
      for (; e && e !== document.documentElement; e = e.parentElement) {
        const style = getComputedStyle(e);
        const canY = /(auto|scroll)/.test(style.overflowY) && e.scrollHeight > e.clientHeight;
        const canX = /(auto|scroll)/.test(style.overflowX) && e.scrollWidth > e.clientWidth;
        if ((dy && canY) || (dx && canX)) {
          e.scrollBy({ left: dx, top: dy, behavior: "instant" });
          return { ok: true, trusted: false };
        }
      }
      window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      return { ok: true, trusted: false };
    }
    if (kind === "drag") {
      const from = at(params.x, params.y);
      const transfer = new DataTransfer();
      move(from, params.x, params.y);
      pointer(from, "pointerdown", params.x, params.y, { button: 0, buttons: 1 });
      mouse(from, "mousedown", params.x, params.y, { button: 0, buttons: 1 });
      const dragging = from.draggable && from.dispatchEvent(new DragEvent("dragstart", opts(params.x, params.y, { dataTransfer: transfer })));
      let over = from;
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = params.x + ((params.to_x - params.x) * i) / steps;
        const y = params.y + ((params.to_y - params.y) * i) / steps;
        over = at(x, y);
        pointer(over, "pointermove", x, y, { buttons: 1 });
        mouse(over, "mousemove", x, y, { buttons: 1 });
        if (dragging) over.dispatchEvent(new DragEvent("dragover", opts(x, y, { dataTransfer: transfer })));
      }
      if (dragging) {
        over.dispatchEvent(new DragEvent("drop", opts(params.to_x, params.to_y, { dataTransfer: transfer })));
        from.dispatchEvent(new DragEvent("dragend", opts(params.to_x, params.to_y, { dataTransfer: transfer })));
      }
      pointer(over, "pointerup", params.to_x, params.to_y, { button: 0 });
      mouse(over, "mouseup", params.to_x, params.to_y, { button: 0 });
      return { ok: true, trusted: false };
    }
    throw new Error("Unsupported input action");
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
