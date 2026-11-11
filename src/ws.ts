// A small WebSocket server (RFC 6455) on top of node:http, so Haanji keeps zero runtime dependencies.
// Supports text and binary messages, fragmentation, ping/pong and close. No extensions.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 4 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  private socket: Duplex;
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partOp = 0;
  closed = false;

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    socket.on("data", (d: Buffer) => this.onData(d));
    socket.on("close", () => this.markClosed());
    socket.on("error", () => this.markClosed());
  }

  private markClosed(): void { if (!this.closed) { this.closed = true; this.emit("close"); } }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MESSAGE) return this.close(1009, "message too big");
      if (!masked) return this.close(1002, "client frames must be masked");
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.onFrame(fin, op, payload);
      if (this.closed) return;
    }
  }

  private onFrame(fin: boolean, op: number, payload: Buffer): void {
    if (op === 0x8) { this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000); return; }
    if (op === 0x9) { this.write(0xa, payload); return; }
    if (op === 0xa) return;
    if (op === 0x1 || op === 0x2) { this.partOp = op; this.parts = [payload]; }
    else if (op === 0x0) this.parts.push(payload);
    else return this.close(1002, "unknown opcode");
    if (!fin) return;
    const whole = Buffer.concat(this.parts);
    this.parts = [];
    if (this.partOp === 0x1) this.emit("text", whole.toString("utf8"));
    else this.emit("binary", whole);
  }

  private write(op: number, payload: Buffer): void {
    if (this.closed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (len >= 126 && len < 65536) { head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else if (len >= 65536) { head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }

  sendText(s: string): void { this.write(0x1, Buffer.from(s, "utf8")); }
  sendBinary(b: Buffer): void { this.write(0x2, b); }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0); body.write(reason, 2);
    this.write(0x8, body);
    this.markClosed();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

/** Completes the handshake, or answers with an HTTP error and returns undefined. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, reject?: { status: number; message: string }): WebSocketConnection | undefined {
  const key = req.headers["sec-websocket-key"];
  if (reject || req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
    const status = reject?.status ?? 400;
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : status === 429 ? "Too Many Requests" : "Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return undefined;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketConnection(socket);
}
