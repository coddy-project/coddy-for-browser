// Approvals: before Coddy's first action on a website, the user says whether
// it may act there - for this chat, always, or not at all. A chat of another
// Coddy process (one that names its node) is asked about first, once, and an
// "always" never covers it: every website it reaches asks for that chat. The
// questions are asked in the browser, never in a page, and a page cannot
// answer them.

import { granted, grant, revoke } from "./policy.js";

export const TIMEOUT_MS = 110000;

export class Approvals {
  // store keeps the sites allowed always, across restarts of the browser;
  // sessionStore keeps what one chat was allowed, until the browser closes
  // (it falls back to store when there is none). onChange is called whenever
  // the queue changes, so the badge and the approval window follow it.
  // home() is the origin of the connected Coddy server, which local addresses
  // never cover.
  constructor({ store, sessionStore = store, onChange = () => {}, timeoutMs = TIMEOUT_MS, home = () => "" }) {
    this.store = store;
    this.home = home;
    this.sessionStore = sessionStore;
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.grants = { always: [], local: true, chats: {}, remote: [] };
    this.pending = new Map();
    this.nextID = 1;
  }

  async load() {
    const kept = (await this.store.get()) || {};
    const session = this.sessionStore === this.store ? kept : (await this.sessionStore.get()) || {};
    this.grants = {
      always: kept.always || [],
      local: kept.local !== false,
      chats: session.chats || {},
      remote: session.remote || [],
    };
    this.loaded = true;
  }

  // persist writes the grants where each kind lives.
  async persist() {
    if (this.sessionStore === this.store) return this.store.set(this.grants);
    await this.store.set({ always: this.grants.always, local: this.grants.local });
    await this.sessionStore.set({ chats: this.grants.chats, remote: this.grants.remote });
  }

  // allowed reports whether origin may be acted on for the chat; an "always"
  // covers the chats of the connected server only.
  allowed(origin, session) {
    return granted(origin, session.id, this.grants, { remote: Boolean(session.node), home: this.home() });
  }

  // chatAllowed reports whether a chat may use this browser at all: every
  // chat of the connected server may, a chat of another Coddy once the user
  // said so.
  chatAllowed(session) {
    return !session.node || this.grants.remote.includes(session.id);
  }

  // ensureChat resolves when the chat may use this browser, asking the user
  // about a chat of another Coddy first.
  ensureChat(session, signal) {
    if (this.chatAllowed(session)) return Promise.resolve();
    return this.ask(
      { kind: "chat", origin: "", action: "use this browser", session },
      signal,
      `The user did not answer whether a chat on ${session.node} may use this browser`,
      (fail, done) => async (choice) => {
        if (choice === "deny") return fail("chat_declined", `The user declined the chat on ${session.node} access to this browser`);
        this.grants = { ...this.grants, remote: [...new Set([...this.grants.remote, session.id])] };
        await this.persist();
        done();
      },
    );
  }

  // ensure resolves when origin may be acted on for the chat, and rejects
  // when the user declines, the question times out or the command is
  // cancelled.
  ensure(origin, session, action, signal) {
    if (this.allowed(origin, session)) return Promise.resolve();
    return this.ask(
      { kind: "site", origin, action, session },
      signal,
      `The user did not answer whether Coddy may act on ${origin}`,
      (fail, done) => async (choice) => {
        if (choice === "deny") return fail("site_declined", `The user declined Coddy access to ${origin}`);
        // An "always" from a chat of another Coddy is an answer for that chat.
        await this.allow(origin, session.id, choice === "always" && !session.node ? "always" : "chat");
        done();
      },
    );
  }

  // ask queues one question; decider(fail, done) makes what an answer does.
  // An answer settles every other question it answers too.
  ask(question, signal, timeoutMessage, decider) {
    // A command cancelled before its question would come up asks nothing.
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("The action was cancelled"), { reason: "cancelled" }));
    const id = String(this.nextID++);
    return new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.pending.delete(id)) this.onChange();
        err ? reject(err) : resolve();
      };
      const fail = (reason, message) => done(Object.assign(new Error(message), { reason }));
      const onAbort = () => fail("cancelled", "The action was cancelled");
      const reason = question.kind === "chat" ? "chat_prompt_timeout" : "site_prompt_timeout";
      const timer = setTimeout(() => fail(reason, timeoutMessage), this.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      const answered = decider(fail, () => {
        // Every other question the answer settles is answered too.
        for (const other of this.pending.values())
          if (other.id !== id && this.settled(other)) other.decide("chat").catch(() => {});
        done();
      });
      const { session } = question;
      this.pending.set(id, {
        id,
        kind: question.kind,
        origin: question.origin,
        action: question.action,
        session: { id: session.id, title: session.title || "", ...(session.node ? { node: session.node } : {}) },
        decide: answered,
      });
      this.onChange();
    });
  }

  settled(q) {
    return q.kind === "chat" ? this.chatAllowed(q.session) : this.allowed(q.origin, q.session);
  }

  async allow(origin, sessionId, scope) {
    this.grants = grant(this.grants, origin, sessionId, scope);
    await this.persist();
  }

  async decide(id, choice) {
    const p = this.pending.get(id);
    if (!p) throw new Error("The question was already answered or expired");
    await p.decide(choice);
  }

  // setLocal turns on or off the local addresses allowed without asking.
  async setLocal(on) {
    this.grants = { ...this.grants, local: Boolean(on) };
    await this.persist();
  }

  async revoke(origin) {
    this.grants = revoke(this.grants, origin);
    await this.persist();
  }

  // cancelAll answers every question with a refusal: the user pressed Stop.
  cancelAll() {
    for (const p of [...this.pending.values()]) p.decide("deny");
  }

  // forgetRemote takes back what the chats of other Coddy processes were
  // allowed: the user pressed Stop, and such a chat asks again next time.
  async forgetRemote() {
    const remote = new Set(this.grants.remote);
    const chats = Object.fromEntries(Object.entries(this.grants.chats).filter(([id]) => !remote.has(id)));
    this.grants = { ...this.grants, chats, remote: [] };
    await this.persist();
  }

  list() {
    return [...this.pending.values()].map(({ id, kind, origin, action, session }) => ({ id, kind, origin, action, session }));
  }
}
