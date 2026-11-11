// Minimal client for a local Ollama server (https://github.com/ollama/ollama/blob/main/docs/api.md).

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface OllamaOptions { host: string; model: string; timeoutMs?: number }

export class OllamaError extends Error {}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : "connection refused";
    throw new OllamaError(`Ollama at ${url.replace(/\/api\/.*/, "")} is not reachable (${why}). Start it with "ollama serve".`);
  }
}

/** One chat turn with a JSON-schema constrained answer. Returns the parsed object. */
export async function chatJson(o: OllamaOptions, messages: ChatMessage[], schema: object): Promise<unknown> {
  const res = await request(`${o.host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: o.model, messages, stream: false, format: schema, options: { temperature: 0.2 } }),
  }, o.timeoutMs ?? 120_000);
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) throw new OllamaError(`Model "${o.model}" is not installed. Run: ollama pull ${o.model}`);
    throw new OllamaError(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
  }
  let content: string;
  try { content = JSON.parse(text).message.content; } catch { throw new OllamaError("Ollama sent a response without a message."); }
  try { return JSON.parse(content); } catch { throw new OllamaError(`The model did not return valid JSON: ${content.slice(0, 200)}`); }
}

export async function listModels(o: OllamaOptions): Promise<string[]> {
  const res = await request(`${o.host}/api/tags`, {}, 5000);
  if (!res.ok) throw new OllamaError(`Ollama returned ${res.status} for /api/tags`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}
