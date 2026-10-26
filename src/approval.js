// The window the extension opens when Coddy asks to use a website and no side
// panel is open to ask it in. It closes when nothing is left to answer.
import { request, showError } from "./ui.js";
import { approvalCard } from "./cards.js";

let rendered = "";

async function refresh() {
  let s;
  try {
    s = await request({ type: "state" });
  } catch (e) {
    showError(e);
    return;
  }
  if (!s.pending.length) {
    window.close();
    return;
  }
  const next = JSON.stringify(s.pending);
  if (next === rendered) return;
  rendered = next;
  document.getElementById("approvals").replaceChildren(...s.pending.map((p) => approvalCard(p, refresh)));
}

await refresh();
setInterval(refresh, 700);
