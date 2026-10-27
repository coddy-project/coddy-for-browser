import test from "node:test";
import assert from "node:assert/strict";
import { siteOf, serverURL, socketURL, fileURL, granted, grant, revoke, isLocalOrigin, covers, LOCAL_SITES, siteEntry, checkKey, checkName } from "../src/policy.js";

test("a website is its origin, scheme and port included", () => {
  assert.equal(siteOf("https://example.com/a?b#c"), "https://example.com");
  assert.equal(siteOf("http://example.com:8080/"), "http://example.com:8080");
  for (const bad of ["file:///etc/passwd", "chrome://settings", "https://user:pw@example.com/", "javascript:alert(1)"])
    assert.throws(() => siteOf(bad));
});

test("plain HTTP reaches only a server on this machine", () => {
  assert.equal(serverURL("http://127.0.0.1:12348"), "http://127.0.0.1:12348");
  assert.equal(serverURL(" http://localhost:12348/ "), "http://localhost:12348");
  assert.equal(serverURL("http://[::1]:12348"), "http://[::1]:12348");
  assert.equal(serverURL("https://coddy.example.org"), "https://coddy.example.org");
  assert.throws(() => serverURL("http://192.168.1.5:12348"), /HTTPS/);
  assert.throws(() => serverURL("https://coddy.example.org/browser"), /path/);
  assert.throws(() => serverURL("https://u:p@coddy.example.org"), /credentials/);
  assert.throws(() => serverURL("ws://127.0.0.1:12348"));
  assert.equal(socketURL("https://coddy.example.org"), "wss://coddy.example.org/browser/v1/connect");
  assert.equal(socketURL("http://127.0.0.1:12348"), "ws://127.0.0.1:12348/browser/v1/connect");
});

test("a transfer ticket is only ever a 48-character hex id", () => {
  const ticket = "a".repeat(48);
  assert.equal(fileURL("http://127.0.0.1:12348", ticket), "http://127.0.0.1:12348/browser/v1/files/" + ticket);
  for (const bad of ["../../etc", "a".repeat(47), "A".repeat(48), ""]) assert.throws(() => fileURL("http://127.0.0.1:1", bad));
});

test("grants are per site, always or for one chat, and revoke takes both", () => {
  let g = { always: [], chats: {} };
  g = grant(g, "https://a.example", "s1", "chat");
  assert.ok(granted("https://a.example", "s1", g));
  assert.ok(!granted("https://a.example", "s2", g));
  assert.ok(!granted("https://a.example:444", "s1", g));
  g = grant(g, "https://b.example", "s1", "always");
  assert.ok(granted("https://b.example", "s9", g));
  g = revoke(g, "https://a.example");
  assert.ok(!granted("https://a.example", "s1", g));
  assert.ok(granted("https://b.example", "s1", g));
});

test("the local entries cover every port of this machine but the Coddy server's, and only for chats of the server", () => {
  const g = { always: [...LOCAL_SITES], chats: {} };
  const home = "http://127.0.0.1:12345";
  for (const origin of ["http://localhost:3000", "https://localhost:8443", "http://127.0.0.1:5173", "http://[::1]:8080"])
    assert.ok(granted(origin, "s1", g, { home }), origin);
  // The web UI of the Coddy server, under any of this machine's names.
  for (const origin of [home, "http://localhost:12345", "http://[::1]:12345"]) assert.ok(!granted(origin, "s1", g, { home }), origin);
  // ...unless the person allowed that very origin.
  assert.ok(granted(home, "s1", { ...g, always: [...g.always, home] }, { home }));
  // A chat of another machine asks about local pages too.
  assert.ok(!granted("http://localhost:3000", "laptop/s1", g, { remote: true, home }));
  // Not this machine: another host, a name that only starts like localhost.
  for (const origin of ["http://192.168.1.10:3000", "http://localhost.example.com", "http://127.0.0.1.example.com", "https://example.com"])
    assert.ok(!granted(origin, "s1", g, { home }), origin);
  // An entry revoked stops covering its host.
  assert.ok(!granted("http://localhost:3000", "s1", revoke(g, "*://localhost:*"), { home }));
  assert.ok(covers("*://localhost:*", "http://localhost:1"));
  assert.ok(!covers("*://localhost:*", "not a url"));
  assert.ok(isLocalOrigin("http://app.localhost:3000") && !isLocalOrigin("https://example.com"));
});

test("an address typed into the list becomes an origin or a pattern of ports", () => {
  const cases = {
    "https://example.com": "https://example.com",
    "HTTP://Example.com:8080": "http://example.com:8080",
    "https://example.com/docs?x=1#top": "https://example.com",
    "localhost:3000": "*://localhost:3000",
    "example.com": "*://example.com:*",
    "example.com:*": "*://example.com:*",
    "*://example.com": "*://example.com:*",
    "http://example.com:*": "http://example.com:*",
    "example.com:1000-2000": "*://example.com:1000-2000",
    "https://example.com:1000-2000": "https://example.com:1000-2000",
    "example.com:5-5": "*://example.com:5",
    "[::1]:8080": "*://[::1]:8080",
    "пример.рф": "*://xn--e1afmkfd.xn--p1ai:*",
  };
  for (const [input, entry] of Object.entries(cases)) assert.equal(siteEntry(input), entry, input);
  for (const bad of ["", "ftp://example.com", "example.com:70000", "example.com:0", "example.com:2000-1000", "a b", "user@example.com"])
    assert.throws(() => siteEntry(bad), undefined, bad);
});

test("a range or a scheme narrows an entry, and only one named port reaches the Coddy server", () => {
  assert.ok(covers("*://example.com:1000-2000", "https://example.com:1500"));
  assert.ok(covers("*://example.com:1000-2000", "http://example.com:1000"));
  assert.ok(!covers("*://example.com:1000-2000", "https://example.com:2001"));
  assert.ok(!covers("*://example.com:1000-2000", "https://example.com"));
  assert.ok(covers("http://example.com:*", "http://example.com:81"));
  assert.ok(!covers("http://example.com:*", "https://example.com"));
  assert.ok(covers("*://example.com:443", "https://example.com"));
  const home = "http://127.0.0.1:12345";
  const g = (always) => ({ always, chats: {} });
  // One named port is the person's word for the Coddy server; a range or "*" is not.
  assert.ok(granted(home, "s1", g(["*://127.0.0.1:12345"]), { home }));
  assert.ok(!granted(home, "s1", g(["*://127.0.0.1:10000-20000"]), { home }));
  assert.ok(!granted(home, "s1", g(["*://127.0.0.1:*"]), { home }));
});

test("every website, for the chats of the server only and never its own web UI", () => {
  const home = "http://127.0.0.1:12345";
  const all = { always: [], chats: {}, all: true };
  assert.ok(granted("https://any.example", "s1", all, { home }));
  assert.ok(granted("http://192.168.1.10:3000", "s1", all, { home }));
  assert.ok(!granted("http://localhost:12345", "s1", all, { home }));
  assert.ok(!granted("https://any.example", "laptop/s1", all, { remote: true, home }));
  assert.ok(granted(home, "s1", { ...all, always: ["*://127.0.0.1:12345"] }, { home }));
});

test("the key and the name are checked before they are kept", () => {
  assert.throws(() => checkKey("short"));
  assert.equal(checkKey(" " + "k".repeat(32) + " "), "k".repeat(32));
  assert.equal(checkName(""), "Chrome");
  assert.equal(checkName("x".repeat(200)).length, 100);
});
