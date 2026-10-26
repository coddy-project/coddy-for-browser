// A JSON-RPC 2.0 peer over any transport that moves whole text messages.
// Coddy and the extension both send requests on the one WebSocket: the
// extension asks initialize, Coddy asks browser/command. The peer is
// transport-agnostic so the tests can drive it without a socket.

export class RPCError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// Codes of the protocol (docs/reference/browser-protocol.md in coddy-agent).
export const codes = {
  failed: -32000,
  unauthorized: -32001,
  protocolVersion: -32002,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
};

export class Peer {
  // send(text) writes one message. It may throw when the transport is gone.
  constructor(send) {
    this.send = send;
    this.nextID = 1;
    this.pending = new Map();
    this.requests = new Map();
    this.notifications = new Map();
    this.running = new Map();
    this.closed = false;
  }

  // onRequest registers handler(params, {id, signal}) for a method; its
  // return value is the result, a thrown error the error answer.
  onRequest(method, handler) {
    this.requests.set(method, handler);
  }

  onNotification(method, handler) {
    this.notifications.set(method, handler);
  }

  write(message) {
    if (this.closed) throw new Error("connection closed");
    this.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  request(method, params = {}, { timeout = 30000 } = {}) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  // receive handles one incoming message. A malformed one is answered when
  // it can be and otherwise dropped; the caller decides whether to close.
  async receive(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    const hasID = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== "string") {
      if (!hasID) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error)
        p.reject(
          new RPCError(msg.error.code, msg.error.message, msg.error.data),
        );
      else p.resolve(msg.result);
      return;
    }
    if (!hasID) {
      const handler = this.notifications.get(msg.method);
      if (handler) await handler(msg.params || {});
      return;
    }
    const handler = this.requests.get(msg.method);
    if (!handler) {
      this.answerError(msg.id, codes.methodNotFound, `method not found: ${msg.method}`);
      return;
    }
    const abort = new AbortController();
    this.running.set(msg.id, abort);
    try {
      const result = await handler(msg.params || {}, {
        id: msg.id,
        signal: abort.signal,
      });
      if (!this.closed) this.write({ id: msg.id, result: result ?? {} });
    } catch (e) {
      const code = e instanceof RPCError ? e.code : codes.failed;
      const data = e instanceof RPCError ? e.data : e.reason ? { reason: e.reason } : undefined;
      this.answerError(msg.id, code, String(e.message || e), data);
    } finally {
      this.running.delete(msg.id);
    }
  }

  answerError(id, code, message, data) {
    if (this.closed) return;
    try {
      this.write({ id, error: data ? { code, message, data } : { code, message } });
    } catch {}
  }

  // cancel aborts a request Coddy sent, when it asks with $/cancelRequest.
  cancel(id) {
    this.running.get(id)?.abort();
  }

  // close fails every request still waiting and aborts the running handlers.
  close(reason = "connection closed") {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    for (const [, abort] of this.running) abort.abort();
    this.running.clear();
  }
}

// failure makes an error the command handler throws with a stable reason
// Coddy can relay (data.reason).
export function failure(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}
