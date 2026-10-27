// The one WebSocket to the HTTP server of Coddy. The extension dials out and
// keeps it open; Coddy's requests come down it. initialize goes first, with
// the key, because a browser cannot set headers on a WebSocket.

import { Peer, RPCError, codes } from "./rpc.js";
import { socketURL } from "./policy.js";

export const PROTOCOL_VERSION = 1;
const PING_MS = 20000;
const HANDSHAKE_MS = 10000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;

// backoff is the wait before reconnect attempt n (0-based): 1 s growing by
// half each time up to a minute, with a fifth of jitter so browsers that lost
// one server do not all come back at once.
export function backoff(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_MIN_MS * 1.5 ** attempt, BACKOFF_MAX_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export class Connection {
  // opts: WebSocket (class), settings() -> {address, key, id, name, enabled},
  // version, actions, grant() -> the current selection, onReady(peer),
  // onStatus(status), setup(peer) to register the handlers before initialize.
  constructor(opts) {
    Object.assign(this, opts);
    this.status = "Disconnected";
    this.attempt = 0;
    this.socket = null;
    this.peer = null;
    this.timers = [];
    this.generation = 0;
    // fatal is why the server refused the extension for good (a wrong key,
    // another protocol version); retrying is set while the next attempt is
    // scheduled. The keepalive alarm dials again only when neither holds.
    this.fatal = "";
    this.retrying = false;
  }

  // idle reports whether nothing would dial again by itself: no socket, no
  // refusal a retry cannot fix, no attempt scheduled.
  idle() {
    return !this.socket && !this.fatal && !this.retrying;
  }

  setStatus(status) {
    this.status = status;
    this.onStatus?.(status);
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t), clearInterval(t);
    this.timers = [];
  }

  // close ends the socket without reconnecting.
  close(status = "Disconnected") {
    this.generation++;
    this.clearTimers();
    this.peer?.close();
    this.peer = null;
    if (this.socket) {
      this.socket.onclose = this.socket.onmessage = this.socket.onerror = this.socket.onopen = null;
      try {
        this.socket.close();
      } catch {}
    }
    this.socket = null;
    this.setStatus(status);
  }

  connected() {
    return !!this.peer && this.status === "Connected";
  }

  // connect (re)opens the socket with the current settings.
  connect() {
    this.close();
    this.fatal = "";
    this.retrying = false;
    const s = this.settings();
    if (!s.enabled) return;
    let url;
    try {
      url = socketURL(s.address);
    } catch (e) {
      this.setStatus(e.message);
      return;
    }
    if (!s.key) {
      this.setStatus("Enter the extension key");
      return;
    }
    const generation = this.generation;
    const ws = new this.WebSocket(url);
    this.socket = ws;
    const peer = new Peer((text) => ws.send(text));
    this.setup?.(peer);
    let fatal = "";
    this.setStatus("Connecting…");
    this.timers.push(setTimeout(() => ws.close(), HANDSHAKE_MS));
    ws.onmessage = (event) => peer.receive(String(event.data));
    ws.onopen = async () => {
      try {
        const result = await peer.request(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            key: s.key,
            browser: { id: s.id, name: s.name, version: this.version },
            actions: this.actions,
            grant: this.grant?.() || "",
          },
          { timeout: HANDSHAKE_MS },
        );
        if (generation !== this.generation) return;
        this.clearTimers();
        this.peer = peer;
        this.attempt = 0;
        this.server = result?.server || {};
        this.setStatus("Connected");
        this.timers.push(
          setInterval(() => {
            try {
              peer.notify("$/ping");
            } catch {}
          }, PING_MS),
        );
        await this.onReady?.(peer);
      } catch (e) {
        if (e instanceof RPCError && (e.code === codes.unauthorized || e.code === codes.protocolVersion)) {
          // Retrying cannot fix a wrong key or an incompatible server.
          fatal =
            e.code === codes.unauthorized
              ? "Coddy refused the extension key"
              : "This Coddy speaks another protocol version; update the extension or Coddy";
        }
        ws.close();
      }
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      peer.close();
      this.peer = null;
      this.socket = null;
      this.clearTimers();
      this.onClosed?.();
      if (fatal) {
        this.fatal = fatal;
        this.setStatus(fatal);
        return;
      }
      const wait = backoff(this.attempt++);
      this.setStatus(`Disconnected; retrying in ${Math.ceil(wait / 1000)} s`);
      this.retrying = true;
      this.timers.push(
        setTimeout(() => {
          this.retrying = false;
          this.connect();
        }, wait),
      );
    };
  }
}
