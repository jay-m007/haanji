// A stand-in for Ollama: answers /api/chat from a queue of scripted model outputs and records what it was sent.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fake { host: string; replies: (object | string)[]; requests: any[]; models: string[]; close: () => Promise<void> }

export async function startFake(models = ["gemma3:4b"]): Promise<Fake> {
  const fake: Partial<Fake> = { replies: [], requests: [], models };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === "/api/tags") { res.end(JSON.stringify({ models: fake.models!.map((name) => ({ name })) })); return; }
    if (req.url === "/api/chat") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      fake.requests!.push(body);
      if (!fake.models!.some((m) => m === body.model)) { res.statusCode = 404; res.end(JSON.stringify({ error: `model "${body.model}" not found` })); return; }
      const next = fake.replies!.shift() ?? { reply: "", language: "hi", intent: "other", end_call: false, lead: {} };
      res.end(JSON.stringify({ message: { role: "assistant", content: typeof next === "string" ? next : JSON.stringify(next) } }));
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake as Fake;
}

/** A model turn with sensible empty defaults. */
export function turn(o: { reply: string; language?: string; intent?: string; end_call?: boolean; lead?: Record<string, unknown> }) {
  return {
    reply: o.reply, language: o.language ?? "hi", intent: o.intent ?? "other", end_call: o.end_call ?? false,
    lead: { name: "", company: "", city: "", phone: "", delivery_by: "", note: "", items: [], offer_price: 0, offer_per: "", offer_product_id: "", ...(o.lead ?? {}) },
  };
}
