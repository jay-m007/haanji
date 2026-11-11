// Password for the dashboard, and the rules for who may connect a phone stream.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const DAY = 86_400_000;

function sign(password: string, value: string): string { return createHmac("sha256", "haanji:" + password).update(value).digest("base64url"); }

export function sessionCookie(password: string, now = Date.now(), days = 30): string {
  const exp = String(now + days * DAY);
  return `haanji=${exp}.${sign(password, exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}`;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function loggedIn(req: IncomingMessage, password: string, now = Date.now()): boolean {
  const v = cookie(req, "haanji");
  if (!v) return false;
  const [exp, sig] = v.split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  return sameSecret(sig, sign(password, exp));
}

/** True when the request came through a tunnel or proxy, i.e. possibly from the internet. */
export function viaProxy(req: IncomingMessage): boolean {
  return Boolean(req.headers["cf-connecting-ip"] || req.headers["cf-ray"] || req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
}

export function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/**
 * Exotel connects with the token either as ?key=TOKEN on the wss URL or as the password of
 * Basic auth (wss://haanji:TOKEN@host/exotel/ws). Without a token set, only local test connections are allowed.
 */
export function exotelAllowed(req: IncomingMessage, url: URL, token: string | undefined): boolean {
  if (!token) return isLoopback(req) && !viaProxy(req);
  const q = url.searchParams.get("key");
  if (q && sameSecret(q, token)) return true;
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Basic ")) {
    const [, pass = ""] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    if (sameSecret(pass, token)) return true;
  }
  return false;
}

export const LOGIN_PAGE = (error = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Haanji login</title><link rel="stylesheet" href="/style.css"></head><body>
<header class="cover"><h1>Haanji <small>sign in</small></h1></header>
<main class="wrap page"><form method="post" action="/login" style="max-width:360px">
<p><label for="pw">Password</label><br><input id="pw" name="password" type="password" autofocus required style="width:100%;padding:8px;font-size:18px"></p>
${error ? `<p class="error" style="padding:0">${error}</p>` : ""}<button class="btn primary">Sign in</button></form></main></body></html>`;
