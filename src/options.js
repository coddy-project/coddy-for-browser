import { request, el, showError, statusClass } from "./ui.js";

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
  $("all").checked = Boolean(s.allowAll);
  $("all-note").hidden = !s.allowAll;
  const next = JSON.stringify(s.allowed);
  if (next !== allowed) {
    allowed = next;
    $("allowed").replaceChildren(
      ...(s.allowed.length
        ? s.allowed.map((origin) => {
            const b = el("button", { type: "button" }, "Revoke");
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
$("all").onchange = () =>
  request({ type: "setAllowAll", on: $("all").checked })
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
