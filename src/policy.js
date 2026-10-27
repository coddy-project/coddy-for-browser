// What the extension lets Coddy reach is decided here, in the extension,
// outside the pages and out of the model's reach.

// siteOf is the origin a website permission is granted for: scheme, host and
// port. Only ordinary web pages qualify.
export function siteOf(address) {
  const url = new URL(address);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only ordinary HTTP(S) pages are supported");
  return url.origin;
}

export function isWebPage(address) {
  try {
    siteOf(address);
    return true;
  } catch {
    return false;
  }
}

const loopback = ["localhost", "127.0.0.1", "[::1]"];

// serverURL is the address of the Coddy server as the user typed it,
// checked: plain HTTP only on this machine, so the key and the pages never
// cross a network in the clear.
export function serverURL(address) {
  const url = new URL(String(address || "").trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Enter an HTTP(S) server address without credentials or query");
  if (url.protocol === "http:" && !loopback.includes(url.hostname))
    throw new Error("Use HTTPS for a Coddy server on another machine");
  if (url.pathname !== "/") throw new Error("Enter the server address without a path");
  return url.origin;
}

export function socketURL(server) {
  return serverURL(server).replace(/^http/, "ws") + "/browser/v1/connect";
}

export function fileURL(server, ticket) {
  if (!/^[a-f0-9]{48}$/.test(ticket || "")) throw new Error("Invalid file transfer");
  return serverURL(server) + "/browser/v1/files/" + ticket;
}

// Grants say which websites Coddy may act on without asking: always, or for
// the rest of one chat (until the browser restarts).
// granted reports whether origin may be acted on for the chat. An "always"
// covers the chats of the connected server, never a remote one.
export function granted(origin, sessionId, grants, { remote = false } = {}) {
  return (!remote && grants.always.includes(origin)) || (grants.chats[sessionId] || []).includes(origin);
}

export function grant(grants, origin, sessionId, scope) {
  if (scope === "always") {
    return { ...grants, always: [...new Set([...grants.always, origin])] };
  }
  const chat = new Set(grants.chats[sessionId] || []);
  chat.add(origin);
  return { ...grants, chats: { ...grants.chats, [sessionId]: [...chat] } };
}

export function revoke(grants, origin) {
  const chats = {};
  for (const [id, origins] of Object.entries(grants.chats)) chats[id] = origins.filter((o) => o !== origin);
  return { ...grants, always: grants.always.filter((o) => o !== origin), chats };
}

// Keys of the extension key and browser name the user types.
export function checkKey(key) {
  if (typeof key !== "string" || key.trim().length < 32)
    throw new Error("The extension key has at least 32 characters");
  return key.trim();
}

export function checkName(name) {
  const value = String(name || "").trim().slice(0, 100);
  return value || "Chrome";
}
