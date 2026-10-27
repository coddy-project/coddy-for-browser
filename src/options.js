import { request, el, showError, statusClass } from "./ui.js";

// siteLabel reads an entry of the list: an origin as it is, a host entry
// ("*://localhost:*") as the host on any port.
function siteLabel(entry) {
  const host = /^\*:\/\/(.+):\*$/.exec(entry)?.[1];
  return host ? `${host}, any port` : entry;
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
$("disconnect").onclick = () =>
  request({ type: "disconnect" })
    .then(refresh)
    .catch(showError);

await refresh();
setInterval(refresh, 1000);
