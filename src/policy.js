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

// isLocalOrigin says whether an origin is on this machine: localhost and its
// subdomains, 127.0.0.0/8 and [::1], on any port.
export function isLocalOrigin(origin) {
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

// LOCAL_SITES start on the list of sites allowed always: this machine under
// the names people use for it, any scheme and port. They are revoked like any
// other entry, and the list remembers it.
export const LOCAL_SITES = ["*://localhost:*", "*://127.0.0.1:*", "*://[::1]:*"];

// An entry of the list is an origin, or "<scheme>://<host>:<ports>" where the
// scheme may be "*" (http or https) and the ports one port, a range "lo-hi"
// or "*" (any).
const PATTERN = /^(\*|https?):\/\/(\[[0-9a-f:.]+\]|[^:[\]/]+):(\*|\d{1,5}(?:-\d{1,5})?)$/;

function inPorts(ports, port) {
  if (ports === "*") return true;
  const [lo, hi = lo] = ports.split("-").map(Number);
  return Number(port) >= lo && Number(port) <= hi;
}

function parts(origin) {
  const url = new URL(origin);
  const scheme = url.protocol.slice(0, -1);
  return { scheme, host: url.hostname, port: url.port || (scheme === "https" ? "443" : "80") };
}

// covers says whether an "always" entry takes in origin.
export function covers(entry, origin) {
  if (entry === origin) return true;
  const m = PATTERN.exec(entry);
  if (!m) return false;
  try {
    const o = parts(origin);
    return (m[1] === "*" || m[1] === o.scheme) && m[2] === o.host && inPorts(m[3], o.port);
  } catch {
    return false;
  }
}

// namesPort says whether an entry names one port: the person's word for what
// listens there, the Coddy server included. A range is as wide as "*".
function namesPort(entry) {
  const m = PATTERN.exec(entry);
  return !m || /^\d+$/.test(m[3]);
}

// siteEntry reads an address the person adds to the list beforehand:
//   https://example.com, http://10.0.0.5:8080   that origin
//   localhost:3000                               that port, http or https
//   example.com:1000-2000                        those ports, http or https
//   example.com, example.com:*, *://example.com  every port, http or https
//   http://example.com:*                         every port, one scheme
export function siteEntry(input) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) throw new Error("Enter an address");
  const bad = () => new Error(`Not an address: ${String(input).trim()}`);
  let scheme = "*";
  let rest = text;
  const m = /^([a-z*]+):\/\/(.*)$/.exec(text);
  if (m) [, scheme, rest] = m;
  if (!["*", "http", "https"].includes(scheme)) throw new Error("Only http and https addresses can be allowed");
  // A pasted page address counts as its site: the path, query and fragment go.
  rest = rest.split(/[/?#]/)[0];
  if (/[@\s]/.test(rest)) throw bad();
  const hp = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\*|\d{1,5}(?:-\d{1,5})?))?$/.exec(rest);
  if (!hp) throw bad();
  let host;
  try {
    host = new URL(`http://${hp[1]}`).hostname;
  } catch {
    throw bad();
  }
  let port = hp[2];
  if (port && port !== "*") {
    const [lo, hi = lo] = port.split("-").map(Number);
    if (lo < 1 || hi > 65535) throw new Error("A port is 1 to 65535");
    if (lo > hi) throw new Error("A range of ports goes from the lower to the higher");
    if (lo === hi) port = String(lo);
  }
  // A scheme with one port, or a scheme alone: an origin (the URL drops a
  // default port).
  if (scheme !== "*" && (!port || /^\d+$/.test(port))) return new URL(`${scheme}://${host}${port ? `:${port}` : ""}`).origin;
  return `${scheme}://${host}:${port || "*"}`;
}

// accessPatterns are the match patterns the browser is asked for to let the
// extension into an origin or an entry of the list: an origin with its port,
// a host on one port under both schemes (Chrome takes no port after "*://"),
// and a host on a range of ports on every port, which a pattern cannot narrow.
export function accessPatterns(entry) {
  const m = PATTERN.exec(entry);
  if (!m) {
    const { scheme, host, port } = parts(entry);
    return [`${scheme}://${host}:${port}/*`];
  }
  const [, scheme, host, ports] = m;
  if (!/^\d+$/.test(ports)) return [`${scheme}://${host}/*`];
  return (scheme === "*" ? ["http", "https"] : [scheme]).map((s) => `${s}://${host}:${ports}/*`);
}

// Grants say which websites Coddy may act on without asking: always, or for
// the rest of one chat (until the browser restarts).
// granted reports whether origin may be acted on for the chat. An "always"
// covers the chats of the connected server, never a remote one, and so does
// grants.all, every website. An entry for every port, and grants.all, leave
// out home, the Coddy server itself, under every local name of its port: its
// web UI approves a chat's own requests, so only an entry that names its port
// lets a chat act there without the person's word.
export function granted(origin, sessionId, grants, { remote = false, home = "" } = {}) {
  if ((grants.chats[sessionId] || []).includes(origin)) return true;
  if (remote) return false;
  if (grants.always.includes(origin)) return true;
  const own = sameServer(origin, home);
  if (grants.always.some((entry) => covers(entry, origin) && (!own || namesPort(entry)))) return true;
  return Boolean(grants.all) && !own;
}

// sameServer says whether origin reaches the server at home: the same origin,
// or for a local home the same port under any of this machine's names
// (http://localhost:12345 is the web UI of http://127.0.0.1:12345).
function sameServer(origin, home) {
  if (!home) return false;
  if (origin === home) return true;
  if (!isLocalOrigin(home)) return false;
  const port = (u) => u.port || (u.protocol === "https:" ? "443" : "80");
  return port(new URL(origin)) === port(new URL(home));
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
