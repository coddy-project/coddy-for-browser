import test from "node:test";
import assert from "node:assert/strict";
import { nextVersion } from "../scripts/next-version.mjs";
import { publishChrome, CHROME_KEYS } from "../scripts/publish-chrome.mjs";
import { amoToken, amoHasVersion } from "../scripts/sign.mjs";
import crypto from "node:crypto";

test("the first release takes the version of package.json", () => {
  assert.equal(nextVersion([], "0.1.0"), "0.1.0");
  assert.equal(nextVersion(["v0.0.9", "latest", "1.2"], "0.1.0"), "0.1.0");
});

test("every later release bumps the patch of the newest tag", () => {
  assert.equal(nextVersion(["0.1.0"], "0.1.0"), "0.1.1");
  assert.equal(nextVersion(["0.1.0", "0.1.9", "0.1.10", "0.1.2"], "0.1.0"), "0.1.11");
});

test("package.json raises the minor or major version past the newest tag", () => {
  assert.equal(nextVersion(["0.1.4"], "0.2.0"), "0.2.0");
  assert.equal(nextVersion(["0.9.3"], "1.0.0"), "1.0.0");
  // A version package.json names that is already tagged is not reused.
  assert.equal(nextVersion(["0.2.0"], "0.2.0"), "0.2.1");
});

test("a bad version in package.json is refused", () => {
  assert.throws(() => nextVersion([], "0.1"), /X\.Y\.Z/);
});

// fakeStore answers the requests publishChrome makes, in order, and records
// them.
function fakeStore(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const next = answers.shift();
    if (!next) throw new Error("unexpected request " + url);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { fetch, calls };
}

const env = {
  CWS_CLIENT_ID: "client",
  CWS_CLIENT_SECRET: "secret",
  CWS_REFRESH_TOKEN: "refresh",
  CWS_PUBLISHER_ID: "pub",
  CWS_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
};
const item = "https://chromewebstore.googleapis.com/v2/publishers/pub/items/abcdefghijklmnopabcdefghijklmnop";

test("a package goes up to the store item and is submitted for review", async () => {
  const { fetch, calls } = fakeStore([
    { body: { access_token: "token" } },
    { body: { uploadState: "IN_PROGRESS" } },
    { body: { lastAsyncUploadState: "SUCCEEDED" } },
    { body: { state: "PENDING_REVIEW" } },
  ]);
  const result = await publishChrome({ fetch, env, zip: new Uint8Array([1, 2, 3]), sleep: async () => {}, log: () => {} });
  assert.equal(result.state, "PENDING_REVIEW");
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.match(String(calls[0].body), /grant_type=refresh_token/);
  assert.match(String(calls[0].body), /refresh_token=refresh/);
  assert.equal(calls[1].url, "https://chromewebstore.googleapis.com/upload/v2/publishers/pub/items/abcdefghijklmnopabcdefghijklmnop:upload");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers.Authorization, "Bearer token");
  assert.deepEqual([...calls[1].body], [1, 2, 3]);
  assert.equal(calls[2].url, item + ":fetchStatus");
  assert.equal(calls[3].url, item + ":publish");
  assert.equal(calls[3].method, "POST");
});

test("an upload the store refuses stops before publishing", async () => {
  const { fetch, calls } = fakeStore([
    { body: { access_token: "token" } },
    { status: 400, body: { error: { message: "The version must be higher than 0.1.0" } } },
  ]);
  await assert.rejects(
    publishChrome({ fetch, env, zip: new Uint8Array([1]), sleep: async () => {}, log: () => {} }),
    /version must be higher/,
  );
  assert.equal(calls.length, 2);
});

test("an upload that fails while the store processes it stops before publishing", async () => {
  const { fetch, calls } = fakeStore([
    { body: { access_token: "token" } },
    { body: { uploadState: "FAILED" } },
  ]);
  await assert.rejects(publishChrome({ fetch, env, zip: new Uint8Array([1]), sleep: async () => {}, log: () => {} }), /FAILED/);
  assert.equal(calls.length, 2);
});

test("without the store's credentials nothing is sent", async () => {
  const { fetch, calls } = fakeStore([]);
  const notes = [];
  const result = await publishChrome({ fetch, env: { CWS_CLIENT_ID: "client" }, zip: new Uint8Array([1]), log: (m) => notes.push(m) });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
  for (const key of CHROME_KEYS.filter((k) => k !== "CWS_CLIENT_ID")) assert.match(notes.join("\n"), new RegExp(key));
});

test("a re-run skips a version the Chrome Web Store already holds", async () => {
  const { fetch, calls } = fakeStore([
    { body: { access_token: "token" } },
    { body: { submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.1.2" }] } } },
  ]);
  const result = await publishChrome({ fetch, env, zip: new Uint8Array([1]), version: "0.1.2", sleep: async () => {}, log: () => {} });
  assert.equal(result.state, "PENDING_REVIEW");
  assert.equal(result.already, true);
  assert.deepEqual(calls.map((c) => c.url), ["https://oauth2.googleapis.com/token", item + ":fetchStatus"]);
});

test("an older version in the store does not stop the upload", async () => {
  const { fetch, calls } = fakeStore([
    { body: { access_token: "token" } },
    { body: { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.1.1" }] } } },
    { body: { uploadState: "SUCCEEDED", crxVersion: "0.1.2" } },
    { body: { state: "PENDING_REVIEW" } },
  ]);
  const result = await publishChrome({ fetch, env, zip: new Uint8Array([1]), version: "0.1.2", sleep: async () => {}, log: () => {} });
  assert.equal(result.state, "PENDING_REVIEW");
  assert.equal(calls[2].url, "https://chromewebstore.googleapis.com/upload/v2/publishers/pub/items/abcdefghijklmnopabcdefghijklmnop:upload");
});

test("the AMO token is a JWT signed with the API secret", () => {
  const token = amoToken({ issuer: "user:1:2", secret: "s3cret", now: 1_700_000_000_000, jti: "nonce" });
  const [head, body, sig] = token.split(".");
  const json = (part) => JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual(json(head), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(json(body), { iss: "user:1:2", jti: "nonce", iat: 1_700_000_000, exp: 1_700_000_060 });
  assert.equal(sig, crypto.createHmac("sha256", "s3cret").update(head + "." + body).digest("base64url"));
});

test("a re-run asks AMO whether the version is already there", async () => {
  const seen = [];
  const answers = { "0.1.2": 200, "0.1.3": 404, "0.1.4": 500 };
  const fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization });
    return new Response("{}", { status: answers[String(url).split("/versions/")[1].replace("/", "")] });
  };
  const args = { fetch, issuer: "user:1:2", secret: "s3cret" };
  assert.equal(await amoHasVersion({ ...args, version: "0.1.2" }), true);
  assert.equal(await amoHasVersion({ ...args, version: "0.1.3" }), false);
  await assert.rejects(amoHasVersion({ ...args, version: "0.1.4" }), /HTTP 500/);
  assert.equal(seen[0].url, "https://addons.mozilla.org/api/v5/addons/addon/coddy-for-browser%40coddy.dev/versions/0.1.2/");
  assert.match(seen[0].auth, /^JWT [\w-]+\.[\w-]+\.[\w-]+$/);
});
