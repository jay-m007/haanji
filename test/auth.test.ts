import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { makeServer } from "../src/server.ts";
import { fakeSpeech } from "../src/speech.ts";
import { loggedIn, sessionCookie } from "../src/auth.ts";
import { ROOT, tempDir } from "./helpers.ts";

const tmp = tempDir();
const servers: { close: () => void }[] = [];
async function start(extra: object) {
  const { server } = makeServer({ port: 0, host: "127.0.0.1", catalogPath: join(ROOT, "catalog.json"), dataFile: join(tmp.dir, `${servers.length}.json`), ollama: { host: "http://127.0.0.1:9", model: "m" }, speech: fakeSpeech(), ...extra });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
after(() => { for (const s of servers) s.close(); tmp.cleanup(); });

test("with a password: pages and API need sign-in, the customer call page does not", async () => {
  const base = await start({ password: "pin-wale" });
  const r = await fetch(base + "/dashboard", { redirect: "manual" });
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/login");
  assert.equal((await fetch(base + "/api/calls")).status, 401);
  for (const p of ["/call", "/call.js", "/call-worklet.js", "/style.css", "/login"]) assert.equal((await fetch(base + p)).status, 200, p);

  const wrong = await fetch(base + "/login", { method: "POST", body: "password=nope", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
  assert.equal(wrong.status, 401);
  const ok = await fetch(base + "/login", { method: "POST", body: "password=pin-wale", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  assert.match(ok.headers.get("set-cookie")!, /HttpOnly/);
  assert.equal((await fetch(base + "/api/calls", { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + "/api/calls", { headers: { cookie: cookie.replace(/.$/, "x") } })).status, 401, "a tampered cookie fails");
});

test("without a password: open on this computer, refused through a tunnel", async () => {
  const base = await start({});
  assert.equal((await fetch(base + "/api/calls")).status, 200);
  const viaTunnel = await fetch(base + "/api/calls", { headers: { "cf-connecting-ip": "1.2.3.4" } });
  assert.equal(viaTunnel.status, 403);
  assert.match((await viaTunnel.json()).error, /HAANJI_PASSWORD/);
  assert.equal((await fetch(base + "/call", { headers: { "cf-connecting-ip": "1.2.3.4" } })).status, 200, "customers can still reach the call page");
});

test("Exotel without a token: local connections only", async () => {
  const base = (await start({})).replace("http", "ws");
  const local = new WebSocket(base + "/exotel/ws");
  await new Promise<void>((r, j) => { local.onopen = () => r(); local.onerror = () => j(new Error("local refused")); });
  local.close();
});

test("cookies expire", () => {
  const c = sessionCookie("pw", Date.now() - 40 * 86_400_000).split(";")[0];
  assert.equal(loggedIn({ headers: { cookie: c } } as any, "pw"), false);
  const fresh = sessionCookie("pw").split(";")[0];
  assert.equal(loggedIn({ headers: { cookie: fresh } } as any, "pw"), true);
  assert.equal(loggedIn({ headers: { cookie: fresh } } as any, "other"), false);
});

test("call page is off when speech is off", async () => {
  const base = await start({ speech: undefined });
  assert.equal((await fetch(base + "/call")).status, 404);
});
