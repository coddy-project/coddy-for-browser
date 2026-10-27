// Cards the side panel and the approval window share.
import { request, el, showError } from "./ui.js";

const choices = [
  ["chat", "Allow for this chat", "primary"],
  ["always", "Always allow", ""],
  ["deny", "Decline", "reject"],
];

// approvalCard asks whether Coddy may act on a website, or whether a chat of
// another Coddy may use this browser at all.
export function approvalCard(p, after) {
  const card = el("div", { class: "card approval" });
  const remote = Boolean(p.session.node);
  const chat = `"${p.session.title || p.session.id}"`;
  if (p.kind === "chat") {
    card.append(
      el("strong", {}, "A chat of another Coddy asks to use this browser"),
      el("p", { class: "origin" }, p.session.node),
      el("p", { class: "muted" }, `The chat ${chat} runs on ${p.session.node}. It reaches only the tabs you share, and asks before each new website.`),
    );
  } else {
    card.append(
      el("strong", {}, "Coddy asks to use a website"),
      el("p", { class: "origin" }, p.origin),
      el("p", { class: "muted" }, `To ${p.action} for the chat ${chat}${remote ? ` on ${p.session.node}` : ""}.`),
    );
  }
  const row = el("div", { class: "row" });
  // A chat of another Coddy is never allowed a website for every chat.
  const offered = p.kind === "chat" || remote ? choices.filter(([choice]) => choice !== "always") : choices;
  for (const [choice, label, kind] of offered) {
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
