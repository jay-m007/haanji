// HTTP server: the call simulator, the leads dashboard and a small JSON API. Node built-ins only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { endCall, newCall, takeTurn, type Call, type Status } from "./agent.ts";
import { loadCatalog, product, type Catalog } from "./catalog.ts";
import { itemMaths } from "./lead.ts";
import { listModels, OllamaError, type OllamaOptions } from "./ollama.ts";
import { Store } from "./store.ts";
import type { Lang } from "./guard.ts";

export interface Config { port: number; host: string; catalogPath: string; dataFile: string; ollama: OllamaOptions }

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const LANGS: Lang[] = ["hi", "mr", "gu", "en", "mixed"];
const STATUSES: Status[] = ["new", "called_back", "won", "lost"];

export function configFromEnv(env = process.env): Config {
  const catalog = env.HAANJI_CATALOG ?? join(ROOT, "catalog.json");
  return {
    port: Number(env.HAANJI_PORT ?? 5050),
    host: env.HAANJI_HOST ?? "127.0.0.1",
    catalogPath: resolve(catalog),
    dataFile: resolve(env.HAANJI_DATA ?? join(ROOT, "data", "calls.json")),
    ollama: { host: (env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "").replace(/^(?!https?:\/\/)/, "http://"), model: env.HAANJI_MODEL ?? "gemma3:4b" },
  };
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > 64 * 1024) throw new HttpError(413, "Request too large."); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Body is not valid JSON."); }
}

class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

/** Adds list-price maths to items so the UI does not need to know the catalog rules. */
function view(c: Call, catalog: Catalog) {
  return { ...c, lead: { ...c.lead, items: c.lead.items.map((i) => ({ ...i, name: product(catalog, i.product_id)?.name ?? i.product_id, ...itemMaths(catalog, i) })) } };
}

function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection from caller-supplied text
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function makeServer(cfg: Config): { server: Server; store: Store; catalog: Catalog } {
  const catalog = loadCatalog(cfg.catalogPath);
  const store = new Store(cfg.dataFile);
  const locks = new Map<string, Promise<unknown>>();
  const serialise = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(id, run.catch(() => {}));
    return run;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const m = path.match(/^\/api\/calls\/([\w-]+)(\/(turn|end))?$/);

      if (req.method === "GET" && (path === "/" || path === "/dashboard" || /^\/[\w.-]+\.(js|css|svg|html)$/.test(path))) {
        const file = path === "/" ? "index.html" : path === "/dashboard" ? "dashboard.html" : path.slice(1);
        const full = join(PUBLIC, file);
        if (!full.startsWith(PUBLIC) || !existsSync(full)) return send(res, 404, { error: "Not found." });
        return send(res, 200, readFileSync(full), TYPES[extname(full)] ?? "application/octet-stream");
      }
      if (req.method === "GET" && path === "/api/health") {
        let models: string[] = [], reachable = true, error = "";
        try { models = await listModels(cfg.ollama); } catch (e) { reachable = false; error = (e as Error).message; }
        const installed = models.some((n) => n === cfg.ollama.model || n === `${cfg.ollama.model}:latest`);
        return send(res, 200, { ollama: { host: cfg.ollama.host, reachable, error, models }, model: cfg.ollama.model, modelInstalled: installed, business: catalog.business, sampleCatalog: !!catalog.sample, reviewNote: catalog.review_note ?? "" });
      }
      if (req.method === "GET" && path === "/api/catalog") return send(res, 200, catalog);
      if (req.method === "GET" && path === "/api/calls") return send(res, 200, store.list().map((c) => view(c, catalog)));
      if (req.method === "GET" && path === "/api/calls.csv") {
        const rows = [["started_at", "language", "status", "name", "company", "city", "phone", "items", "last_offer", "delivery_by", "needs_check", "summary"]];
        for (const c of store.list()) {
          const o = c.lead.offers[c.lead.offers.length - 1];
          rows.push([c.started_at, c.language, c.status, c.lead.name, c.lead.company, c.lead.city, c.lead.phone,
            c.lead.items.map((i) => `${i.quantity} ${i.unit} ${i.product_id}`).join("; "), o ? `${o.price}${o.per ? "/" + o.per : ""}` : "",
            c.lead.delivery_by, c.lead.items.some((i) => i.check) ? "yes" : "", c.summary ?? ""]);
        }
        res.setHeader("content-disposition", 'attachment; filename="haanji-calls.csv"');
        return send(res, 200, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv; charset=utf-8");
      }
      if (req.method === "POST" && path === "/api/calls") {
        const body = await readJson(req);
        const lang: Lang = LANGS.includes(body.language) ? body.language : "hi";
        const call = newCall(randomUUID(), catalog, lang, cfg.ollama.model);
        store.put(call);
        return send(res, 201, view(call, catalog));
      }
      if (m) {
        const id = m[1];
        const existing = store.get(id);
        if (!existing) return send(res, 404, { error: "No such call." });
        if (req.method === "GET" && !m[3]) return send(res, 200, view(existing, catalog));
        if (req.method === "PATCH" && !m[3]) {
          const body = await readJson(req);
          if (!STATUSES.includes(body.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}.`);
          if (existing.status === "live") throw new HttpError(409, "End the call before changing its status.");
          const next = { ...existing, status: body.status as Status };
          store.put(next);
          return send(res, 200, view(next, catalog));
        }
        if (req.method === "POST" && m[3] === "turn") {
          const body = await readJson(req);
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) throw new HttpError(400, "Say or type something first.");
          if (text.length > 1000) throw new HttpError(400, "That message is too long for one turn.");
          return await serialise(id, async () => {
            const cur = store.get(id)!;
            if (cur.status !== "live") throw new HttpError(409, "This call has ended.");
            const r = await takeTurn(cur, text, { catalog, ollama: cfg.ollama });
            let call = r.call;
            if (r.endCall) call = endCall(call, catalog);
            store.put(call);
            send(res, 200, { reply: r.reply, guard: r.guard, ended: r.endCall, call: view(call, catalog) });
          });
        }
        if (req.method === "POST" && m[3] === "end") {
          return await serialise(id, async () => {
            const cur = store.get(id)!;
            const call = cur.status === "live" ? endCall(cur, catalog) : cur;
            store.put(call);
            send(res, 200, view(call, catalog));
          });
        }
      }
      send(res, 404, { error: "Not found." });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof OllamaError) return send(res, 503, { error: e.message });
      console.error(e);
      send(res, 500, { error: "Something went wrong on the server. See the terminal for details." });
    }
  });
  return { server, store, catalog };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = configFromEnv();
  const { server, catalog } = makeServer(cfg);
  server.listen(cfg.port, cfg.host, async () => {
    console.log(`Haanji is answering for ${catalog.business.name}${catalog.review_note ? ` (${catalog.review_note})` : ""}`);
    console.log(`  Call simulator: http://${cfg.host}:${cfg.port}/`);
    console.log(`  Dashboard:      http://${cfg.host}:${cfg.port}/dashboard`);
    try {
      const models = await listModels(cfg.ollama);
      if (!models.some((n) => n === cfg.ollama.model || n === `${cfg.ollama.model}:latest`)) console.log(`  ! Model ${cfg.ollama.model} is not installed. Run: ollama pull ${cfg.ollama.model}`);
      else console.log(`  Model: ${cfg.ollama.model} via ${cfg.ollama.host}`);
    } catch (e) { console.log(`  ! ${(e as Error).message}`); }
  });
}
