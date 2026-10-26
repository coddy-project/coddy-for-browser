// A stand-in for Coddy's browser listener, enough to drive the real extension
// in a real Chromium: the WebSocket endpoint speaking the protocol, the file
// transfer route, and a few fixture pages. Node alone - the WebSocket server
// below implements the part of RFC 6455 the extension uses (text frames,
// close, ping).

import http from "node:http";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

class Socket {
  constructor(raw, onMessage, onClose) {
    this.raw = raw;
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    raw.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse(onMessage);
    });
    raw.on("close", onClose);
    raw.on("error", () => {});
  }
  parse(onMessage) {
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = this.buffer[0] & 0x80;
      const op = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        at = 10;
      }
      if (this.buffer.length < at + 4 + len) return;
      const mask = this.buffer.subarray(at, at + 4);
      const data = Buffer.from(this.buffer.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(at + 4 + len);
      if (op === 8) return this.close();
      if (op === 9) {
        this.raw.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
        continue;
      }
      if (op === 1 || op === 0) {
        this.parts.push(data);
        if (fin) {
          onMessage(Buffer.concat(this.parts).toString());
          this.parts = [];
        }
      }
    }
  }
  send(text) {
    this.raw.write(frame(text));
  }
  close() {
    try {
      this.raw.end(Buffer.from([0x88, 0]));
    } catch {}
    this.raw.destroy();
  }
}

// startMockCoddy serves the listener on a free loopback port. It records what
// the extension sent and lets a test send commands.
export async function startMockCoddy({ key }) {
  const state = { socket: null, tabs: [], stops: 0, notes: [], pending: new Map(), files: new Map(), nextID: 1, ready: null };
  let resolveReady;
  state.ready = new Promise((r) => (resolveReady = r));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/browser/v1/files/")) {
      if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
      const id = url.pathname.split("/").pop();
      const t = state.files.get(id);
      if (!t) return res.writeHead(404).end();
      if (req.method === "GET" && t.toPage) {
        state.files.delete(id);
        return res.writeHead(200, { "content-type": "application/octet-stream" }).end(t.data);
      }
      if (req.method === "POST" && !t.toPage) {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          t.data = Buffer.concat(chunks);
          t.done = true;
          res.writeHead(204).end();
        });
        return;
      }
      return res.writeHead(405).end();
    }
    if (url.pathname === "/fixture") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>Coddy fixture</title>
<style>body{font:16px system-ui;margin:24px} button,input{font:inherit;margin:6px 0;display:block}</style>
<h1>Coddy fixture</h1>
<button id="b" onclick="this.textContent='Clicked'">Click me</button>
<label>Name <input id="name" aria-label="Name"></label>
<input type="password" aria-label="Secret" value="hunter2">
<input id="file" type="file" aria-label="Upload" onchange="document.title='uploaded '+this.files[0].name">
<a href="/download">Download</a>
<div id="hover" role="button" tabindex="0" onmouseenter="this.textContent='hovered'" style="padding:20px;background:#ddd">Hover me</div>
<div style="height:3000px"></div>`);
    }
    if (url.pathname === "/download") return res.writeHead(200).end("download fixture");
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, raw) => {
    const url = new URL(req.url, "http://x");
    const origin = req.headers.origin || "";
    if (url.pathname !== "/browser/v1/connect" || !origin.startsWith("chrome-extension://")) {
      raw.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    raw.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const socket = new Socket(
      raw,
      (text) => {
        const msg = JSON.parse(text);
        if (msg.method === "initialize") {
          if (msg.params.key !== key) {
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "invalid extension key" } }));
            return socket.close();
          }
          state.hello = msg.params;
          state.socket = socket;
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, server: { name: "coddy", version: "mock" }, limits: { maxFileBytes: 33554432 } },
            }),
          );
          return;
        }
        if (msg.method === "browser/tabs") {
          state.tabs = msg.params.tabs;
          state.grant = msg.params.grant;
          resolveReady();
          return;
        }
        if (msg.method === "browser/stop") return void state.stops++;
        if (msg.method) return void state.notes.push(msg.method);
        const p = state.pending.get(msg.id);
        if (p) {
          state.pending.delete(msg.id);
          msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result);
        }
      },
      () => {
        if (state.socket === socket) state.socket = null;
      },
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    // command sends browser/command and resolves with its answer.
    command(action, { tabId, params = {}, session = { id: "sess_e2e", title: "E2E chat" } } = {}) {
      const id = crypto.randomBytes(24).toString("hex");
      return new Promise((resolve, reject) => {
        state.pending.set(id, { resolve, reject });
        state.socket.send(
          JSON.stringify({ jsonrpc: "2.0", id, method: "browser/command", params: { action, tabId, params, grant: state.grant, session } }),
        );
      });
    },
    notify(method, params) {
      state.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    stage(data, toPage) {
      const id = crypto.randomBytes(24).toString("hex");
      state.files.set(id, { data, toPage });
      return id;
    },
    close: () => new Promise((r) => (state.socket?.close(), server.close(r))),
  };
}
