import test from "node:test";
import assert from "node:assert/strict";
import { siteOf, serverURL, socketURL, fileURL, granted, grant, revoke, isLocalOrigin, covers, LOCAL_SITES, checkKey, checkName } from "../src/policy.js";

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

test("the key and the name are checked before they are kept", () => {
  assert.throws(() => checkKey("short"));
  assert.equal(checkKey(" " + "k".repeat(32) + " "), "k".repeat(32));
  assert.equal(checkName(""), "Chrome");
  assert.equal(checkName("x".repeat(200)).length, 100);
});
