// Website approvals: before Coddy's first action on a website, the user says
// whether it may act there - for this chat, always, or not at all. The
// question is asked in the browser, never in a page, and a page cannot answer
// it.

import { granted, grant, revoke } from "./policy.js";

export const TIMEOUT_MS = 110000;

export class Approvals {
  // store keeps {always, chats}; onChange is called whenever the queue
  // changes, so the badge and the approval window follow it.
  constructor({ store, onChange = () => {}, timeoutMs = TIMEOUT_MS }) {
    this.store = store;
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.grants = { always: [], chats: {} };
    this.pending = new Map();
    this.nextID = 1;
  }

  async load() {
    this.grants = (await this.store.get()) || { always: [], chats: {} };
    this.grants.always ||= [];
    this.grants.chats ||= {};
  }

  allowed(origin, sessionId) {
    return granted(origin, sessionId, this.grants);
  }

  // ensure resolves when origin may be acted on for the chat, and rejects
  // when the user declines, the question times out or the command is
  // cancelled.
  ensure(origin, session, action, signal) {
    if (this.allowed(origin, session.id)) return Promise.resolve();
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
      const timer = setTimeout(
        () => fail("site_prompt_timeout", `The user did not answer whether Coddy may act on ${origin}`),
        this.timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        id,
        origin,
        action,
        session: { id: session.id, title: session.title || "" },
        decide: async (choice) => {
          if (choice === "deny") return fail("site_declined", `The user declined Coddy access to ${origin}`);
          await this.allow(origin, session.id, choice === "always" ? "always" : "chat");
          // Every other question about the same site and chat is answered too.
          for (const other of this.pending.values())
            if (other.id !== id && this.allowed(other.origin, other.session.id)) other.decide("chat");
          done();
        },
      });
      this.onChange();
    });
  }

  async allow(origin, sessionId, scope) {
    this.grants = grant(this.grants, origin, sessionId, scope);
    await this.store.set(this.grants);
  }

  async decide(id, choice) {
    const p = this.pending.get(id);
    if (!p) throw new Error("The question was already answered or expired");
    await p.decide(choice);
  }

  async revoke(origin) {
    this.grants = revoke(this.grants, origin);
    await this.store.set(this.grants);
  }

  // cancelAll answers every question with a refusal: the user pressed Stop.
  cancelAll() {
    for (const p of [...this.pending.values()]) p.decide("deny");
  }

  list() {
    return [...this.pending.values()].map(({ id, origin, action, session }) => ({ id, origin, action, session }));
  }
}
