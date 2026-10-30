// A stand-in for the HTTP server of Coddy, enough to drive the real extension
// in a real Chromium: the WebSocket endpoint speaking the protocol, the file
// transfer route, a few fixture pages, and a web UI that plays the real one's
// part in the side panel (the ticket sign-in, the theme, the tab of a turn).
// Node alone - the WebSocket server below implements the part of RFC 6455 the
// extension uses (text frames, close, ping).

import http from "node:http";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const body = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

// WEB_UI is the part of Coddy's web UI the side panel relies on, in the same
// messages: the sign-in by the ticket, the theme, the tab of a turn.
const WEB_UI = `<!doctype html><title>Coddy</title>
<style>body{margin:0;padding:16px;background:#0f0f10;color:#fff;font:14px system-ui}textarea{display:block;width:100%;height:60px}</style>
<p id="who">Signing in</p>
<textarea id="composer" aria-label="Message"></textarea>
<button id="send">Send</button>
<p id="answer"></p>
<script>
const q = new URLSearchParams(location.search);
const origin = q.get("coddy_panel_origin");
fetch("/mock/signin", { method: "POST", body: q.get("coddy_panel") || "" })
  .then((r) => r.text())
  .then((t) => (document.getElementById("who").textContent = t));
parent.postMessage({ source: "coddy-web-ui", type: "theme", theme: {
  scheme: "dark", bg: "rgb(15, 15, 16)", surface: "rgba(14, 14, 18, 0.62)", border: "rgba(255, 255, 255, 0.12)",
  text: "rgb(255, 255, 255)", muted: "rgb(156, 163, 175)", accent: "rgb(147, 51, 234)" } }, origin);
let n = 0;
// A run that cannot reach into the frame (Firefox over BiDi) hands it the
// next message through the server and reads the answer back from it.
setInterval(async () => {
  const next = await (await fetch("/mock/next?width=" + innerWidth + "&scale=" + devicePixelRatio)).text();
  if (!next) return;
  document.getElementById("composer").value = next;
  document.getElementById("send").click();
}, 200);
document.getElementById("send").onclick = () => {
  const requestId = "turn-" + ++n;
  const text = document.getElementById("composer").value;
  const sessionId = "sess_panel_1";
  addEventListener("message", function answered(ev) {
    const m = ev.data;
    if (ev.source !== parent || ev.origin !== origin || !m || m.source !== "coddy-for-browser" || m.requestId !== requestId) return;
    removeEventListener("message", answered);
    fetch("/mock/turn", { method: "POST", body: JSON.stringify({ text, sessionId, tab: m.tab }) })
      .then((r) => r.text())
      .then((a) => {
        document.getElementById("answer").textContent = a;
        fetch("/mock/answer", { method: "POST", body: a });
      });
  });
  parent.postMessage({ source: "coddy-web-ui", type: "turn", requestId, sessionId, title: text }, origin);
};
</script>`;

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
  const state = {
    socket: null,
    tabs: [],
    stops: 0,
    notes: [],
    pending: new Map(),
    files: new Map(),
    tickets: new Set(),
    signins: 0,
    nextID: 1,
    ready: null,
  };
  let resolveReady;
  state.ready = new Promise((r) => (resolveReady = r));
  let api;
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
    // The web UI as the side panel loads it: signed in by the ticket of the
    // address, it reports its theme and asks the panel for the tab of a turn.
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(WEB_UI);
    }
    if (url.pathname === "/mock/next") {
      // How the frame is laid out, which a run over BiDi cannot read from it.
      state.frame = { width: Number(url.searchParams.get("width")), scale: Number(url.searchParams.get("scale")) };
      const next = state.next || "";
      state.next = "";
      return res.writeHead(200).end(next);
    }
    if (url.pathname === "/mock/answer" && req.method === "POST") {
      return body(req).then((a) => {
        state.answer = a.toString();
        res.writeHead(204).end();
      });
    }
    if (url.pathname === "/mock/signin" && req.method === "POST") {
      return body(req).then((ticket) => {
        const ok = state.tickets.delete(ticket.toString());
        if (ok) state.signins++;
        res.writeHead(ok ? 200 : 401).end(ok ? "Signed in" : "Refused");
      });
    }
    if (url.pathname === "/mock/turn" && req.method === "POST") {
      return body(req).then(async (raw) => {
        // Coddy's side of the turn: the browser tool reads the tab the
        // person writes from, the default tab of the panel's chat.
        const turn = JSON.parse(raw.toString());
        state.turn = turn;
        try {
          const page = await api.command("snapshot", { tabId: turn.tab.tab_id, session: { id: turn.sessionId, title: turn.text } });
          res.writeHead(200).end(`The page is ${page.title}.`);
        } catch (e) {
          res.writeHead(200).end(`Failed: ${e.message}`);
        }
      });
    }
    res.writeHead(404).end();
  });
  // serverRequest answers what the extension asks of Coddy: panel/open, a
  // one-time ticket that signs the side panel's web UI in.
  async function serverRequest(socket, msg) {
    if (msg.method === "panel/open") {
      const ticket = crypto.randomBytes(32).toString("hex");
      state.tickets.add(ticket);
      return socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ticket } }));
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
  }
  function coddyAsk(method, params) {
    const id = crypto.randomBytes(24).toString("hex");
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      state.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  server.on("upgrade", (req, raw) => {
    const url = new URL(req.url, "http://x");
    const origin = req.headers.origin || "";
    if (url.pathname !== "/browser/v1/connect" || !/^(chrome|moz)-extension:\/\//.test(origin)) {
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
              result: { protocolVersion: 1, server: { name: "coddy", version: "dev" }, limits: { maxFileBytes: 33554432 } },
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
        if (msg.method && msg.id !== undefined) return void serverRequest(socket, msg);
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
  // CODDY_MOCK_PORT pins the port, for screenshots that show the default
  // address of the server.
  await new Promise((r) => server.listen(Number(process.env.CODDY_MOCK_PORT) || 0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  api = {
    base,
    state,
    // send has the web UI in the panel's frame send a message, as a person
    // typing it would.
    send(text) {
      state.next = text;
    },
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
  return api;
}
