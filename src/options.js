import { request, el, showError, statusClass } from "./ui.js";

// trashIcon is the glyph of a row's Revoke button, built with DOM calls
// rather than markup, which the add-on stores' review flags.
function trashIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13M10 11v6M14 11v6");
  svg.append(path);
  return svg;
}

// siteLabel reads an entry of the list: an origin as it is, a pattern
// ("<scheme>://<host>:<ports>") as the host, its ports and, when it names one,
// the scheme.
function siteLabel(entry) {
  const m = /^(\*|https?):\/\/(.+):(\*|[\d-]+)$/.exec(entry);
  if (!m) return entry;
  const [, scheme, host, ports] = m;
  const where = scheme === "*" ? host : `${scheme}://${host}`;
  if (ports === "*") return `${where}, any port`;
  return ports.includes("-") ? `${where}, ports ${ports}` : `${where}:${ports}`;
}

const $ = (id) => document.getElementById(id);
let filled = false;
let allowed = "";

async function refresh() {
  let s;
  try {
    s = await request({ type: "state" });
  } catch (e) {
    showError(e);
    return;
  }
  $("status").textContent = s.status;
  $("status").className = "status " + statusClass(s.status);
  if (!filled) {
    $("address").value = s.settings.address || "http://127.0.0.1:12345";
    $("name").value = s.settings.name || "";
    $("key").placeholder = s.settings.keySet ? "Keep the current key" : "browser.token of the server";
    filled = true;
  }
  $("server").textContent = s.server ? `Connected to Coddy ${s.server.version || ""}`.trim() : "";
  $("version").textContent = `Extension ${s.version}, protocol 1`;
  $("all").setAttribute("aria-checked", String(Boolean(s.allowAll)));
  $("all-note").hidden = !s.allowAll;
  const next = JSON.stringify(s.allowed);
  if (next !== allowed) {
    allowed = next;
    $("allowed").replaceChildren(
      ...(s.allowed.length
        ? s.allowed.map((origin) => {
            const b = el("button", { type: "button", class: "icon remove", title: "Revoke", "aria-label": "Revoke" });
            b.replaceChildren(trashIcon());
            b.onclick = () =>
              request({ type: "revoke", origin })
                .then(refresh)
                .catch(showError);
            return el("li", {}, el("span", { title: origin }, siteLabel(origin)), b);
          })
        : [el("li", { class: "muted" }, "None yet.")]),
    );
  }
}

$("connect").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await request({ type: "save", address: $("address").value, key: $("key").value, name: $("name").value });
    $("key").value = "";
    $("key").placeholder = "Keep the current key";
    showError(null);
    await refresh();
  } catch (e) {
    showError(e);
  }
};
$("all").onclick = () =>
  request({ type: "setAllowAll", on: $("all").getAttribute("aria-checked") !== "true" })
    .then(refresh)
    .catch(showError);
$("add-site").onsubmit = async (event) => {
  event.preventDefault();
  const said = $("site-error");
  try {
    await request({ type: "allowSite", site: $("site").value });
    $("site").value = "";
    said.hidden = true;
    await refresh();
  } catch (e) {
    said.textContent = String(e?.message || e);
    said.hidden = false;
  }
};
$("disconnect").onclick = () =>
  request({ type: "disconnect" })
    .then(refresh)
    .catch(showError);

await refresh();
setInterval(refresh, 1000);
