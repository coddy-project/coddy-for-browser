// Helpers the extension's pages share.
import { api } from "./platform.js";

export async function request(msg) {
  const r = await api.runtime.sendMessage(msg);
  if (!r) throw new Error("The extension did not answer; reload it");
  if (r.error) throw new Error(r.error);
  return r.value;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== "" && v !== undefined) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

export function showError(e) {
  const box = document.getElementById("error");
  if (!box) return;
  box.hidden = !e;
  box.textContent = e ? String(e.message || e) : "";
}

export function statusClass(status) {
  if (status === "Connected") return "ok";
  if (/^Connecting|retrying/.test(status)) return "wait";
  if (status === "Disconnected") return "off";
  return "bad";
}
