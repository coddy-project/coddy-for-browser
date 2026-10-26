// The side panel's chat, on the service worker's side: it runs the panel's
// requests on Coddy (chat/new, chat/send ...) and brings back to the panel
// what Coddy asks of the person while a turn runs (chat/permission,
// chat/question). A panel talks to it through a runtime port.

const SEND_TIMEOUT_MS = 60 * 60 * 1000;

export class ChatBridge {
  // connection: the Connection to Coddy; groups: the tab groups.
  constructor({ connection, groups, publish }) {
    this.connection = connection;
    this.groups = groups;
    this.publish = publish;
    // A panel per window at most; a turn's questions go to the panel that
    // sent it, and to any panel showing the chat when that one is gone.
    this.ports = new Set();
    this.watching = new Map();
    this.waiting = new Map();
    this.nextID = 1;
  }

  peer() {
    const peer = this.connection.connected() && this.connection.peer;
    if (!peer) throw new Error("Not connected to Coddy");
    return peer;
  }

  // setup registers the chat's handlers on a fresh connection.
  setup(peer) {
    peer.onNotification("chat/update", (u) => this.toPanels(u.sessionId, { type: "update", update: u }));
    peer.onRequest("chat/permission", (params, { signal }) => this.ask("permission", params, signal));
    peer.onRequest("chat/question", (params, { signal }) => this.ask("question", params, signal));
  }

  panelsOf(sessionId) {
    return [...this.ports].filter((p) => this.watching.get(p) === sessionId);
  }

  toPanels(sessionId, msg) {
    for (const port of this.panelsOf(sessionId)) {
      try {
        port.postMessage(msg);
      } catch {}
    }
  }

  // ask shows a question of Coddy's in the panels of the chat and resolves
  // with the first answer. No panel, a closed panel or a cancelled turn
  // refuses it.
  ask(kind, params, signal) {
    const panels = this.panelsOf(params.sessionId);
    if (!panels.length) return Promise.reject(new Error("No side panel shows this chat"));
    const id = String(this.nextID++);
    return new Promise((resolve, reject) => {
      const done = (fn, value) => {
        if (!this.waiting.delete(id)) return;
        signal?.removeEventListener("abort", onAbort);
        this.toPanels(params.sessionId, { type: "settled", requestId: id });
        fn(value);
      };
      const onAbort = () => done(reject, new Error("The turn ended"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(id, {
        sessionId: params.sessionId,
        resolve: (v) => done(resolve, v),
        reject: (e) => done(reject, e),
      });
      this.toPanels(params.sessionId, { type: kind, requestId: id, ...params });
    });
  }

  answer(requestId, value) {
    this.waiting.get(requestId)?.resolve(value);
  }

  // attach serves one panel's port.
  attach(port) {
    this.ports.add(port);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      const sessionId = this.watching.get(port);
      this.watching.delete(port);
      // A question nobody else can see is refused when its panel closes.
      for (const [, w] of this.waiting)
        if (w.sessionId === sessionId && !this.panelsOf(sessionId).length) w.reject(new Error("The side panel closed"));
    });
    port.onMessage.addListener((msg) => void this.onPanel(port, msg));
  }

  reply(port, msg) {
    try {
      port.postMessage(msg);
    } catch {}
  }

  async onPanel(port, msg) {
    const reply = (value, error) => this.reply(port, { type: "reply", id: msg.id, value, error });
    try {
      switch (msg.type) {
        case "watch":
          this.watching.set(port, msg.sessionId || "");
          return reply(true);
        case "list":
          return reply(await this.peer().request("chat/list", {}));
        case "messages":
          return reply(await this.peer().request("chat/messages", { sessionId: msg.sessionId }));
        case "new": {
          const created = await this.peer().request("chat/new", msg.permissionMode ? { permissionMode: msg.permissionMode } : {});
          this.watching.set(port, created.sessionId);
          return reply(created);
        }
        case "send": {
          this.watching.set(port, msg.sessionId);
          let tab;
          if (msg.tabId) {
            // The tab the person writes from becomes the chat's to work in.
            const adopted = await this.groups.adopt(msg.tabId, { id: msg.sessionId, title: msg.title || "" });
            await this.publish();
            tab = { id: adopted.id, url: adopted.url, title: adopted.title || "" };
          }
          const result = await this.peer().request(
            "chat/send",
            { sessionId: msg.sessionId, text: msg.text, ...(tab ? { tab } : {}) },
            { timeout: SEND_TIMEOUT_MS },
          );
          return reply(result);
        }
        case "mode":
          return reply(await this.peer().request("chat/mode", { sessionId: msg.sessionId, permissionMode: msg.permissionMode }));
        case "cancel":
          this.peer().notify("chat/cancel", { sessionId: msg.sessionId });
          return reply(true);
        case "answer":
          this.answer(msg.requestId, msg.value);
          return reply(true);
      }
      reply(null, "Unknown request");
    } catch (e) {
      reply(null, String(e?.message || e));
    }
  }

  open() {
    return this.ports.size > 0;
  }
}
