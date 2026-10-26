// Cards the side panel and the approval window share.
import { request, el, showError } from "./ui.js";

const choices = [
  ["chat", "Allow for this chat", "primary"],
  ["always", "Always allow", ""],
  ["deny", "Decline", "danger"],
];

// approvalCard asks whether Coddy may act on a website.
export function approvalCard(p, after) {
  const card = el("div", { class: "card approval" });
  card.append(
    el("strong", {}, "Coddy asks to use a website"),
    el("p", { class: "origin" }, p.origin),
    el("p", { class: "muted" }, `To ${p.action} for the chat "${p.session.title || p.session.id}".`),
  );
  const row = el("div", { class: "row" });
  for (const [choice, label, kind] of choices) {
    const b = el("button", { type: "button", class: kind }, label);
    b.onclick = () =>
      request({ type: "decide", id: p.id, choice })
        .then(after)
        .catch(showError);
    row.append(b);
  }
  card.append(row);
  return card;
}
