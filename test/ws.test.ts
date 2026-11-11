import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { acceptUpgrade } from "../src/ws.ts";

test("WebSocket server: echoes text and binary (including large frames) to Node's own client, and closes cleanly", async () => {
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    if (req.url === "/nope") return void acceptUpgrade(req, socket, { status: 401, message: "no" });
    const c = acceptUpgrade(req, socket)!;
    c.on("text", (t: string) => c.sendText("echo:" + t));
    c.on("binary", (b: Buffer) => c.sendBinary(b));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/x`);
  ws.binaryType = "arraybuffer";
  const got: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => { ws.send("नमस्ते"); ws.send(new Uint8Array(70_000).fill(7)); ws.send(new Uint8Array([1, 2, 3])); };
    ws.onmessage = (e) => { got.push(e.data); if (got.length === 3) resolve(); };
    ws.onerror = () => reject(new Error("socket error"));
  });
  assert.equal(got[0], "echo:नमस्ते");
  assert.equal((got[1] as ArrayBuffer).byteLength, 70_000);
  assert.deepEqual([...new Uint8Array(got[2] as ArrayBuffer)], [1, 2, 3]);
  await new Promise<void>((r) => { ws.onclose = () => r(); ws.close(); });

  const bad = new WebSocket(`ws://127.0.0.1:${port}/nope`);
  await new Promise<void>((r) => { bad.onerror = () => r(); bad.onopen = () => assert.fail("should be refused"); });
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});
