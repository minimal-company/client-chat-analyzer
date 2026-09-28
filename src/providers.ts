import { GoogleGenAI, type Content } from "@google/genai";
import type { ProviderConfig } from "./settings.js";

// Adaptadores de los proveedores de IA para el chat de preguntas: Gemini (SDK de Google), API
// compatible con OpenAI (OpenAI, DeepSeek, OpenRouter y proveedores propios) y Anthropic. Todos
// entregan lo mismo: fragmentos de texto y avisos de "está pensando" (señal de vida).

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const GEMINI_DEFAULT_URL = "https://generativelanguage.googleapis.com";
const clients = new Map<string, GoogleGenAI>();

/** Cliente de Gemini por clave y URL (se rehace solo si cambian desde el panel). */
export function geminiClient(apiKey: string, baseUrl?: string): GoogleGenAI {
  const url = (baseUrl ?? "").replace(/\/+$/, "");
  const id = `${apiKey}|${url}`;
  let client = clients.get(id);
  if (!client) {
    const custom = url && url !== GEMINI_DEFAULT_URL;
    client = new GoogleGenAI({ apiKey, ...(custom ? { httpOptions: { baseUrl: url } } : {}) });
    if (clients.size >= 8) clients.clear();
    clients.set(id, client);
  }
  return client;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export type Chunk = { type: "thinking" } | { type: "text"; text: string };

export interface ChatRequest {
  model: string;
  system: string;
  history: ChatTurn[];
  question: string;
  signal: AbortSignal;
  /** Gemini: pedir el razonamiento a medida que avanza (solo como señal de vida; no se muestra). */
  thoughts: boolean;
}

export function streamChat(p: ProviderConfig, apiKey: string, req: ChatRequest): AsyncGenerator<Chunk> {
  if (p.kind === "gemini") return geminiStream(p, apiKey, req);
  if (p.kind === "anthropic") return anthropicStream(p, apiKey, req);
  return openaiStream(p, apiKey, req);
}

async function* geminiStream(p: ProviderConfig, apiKey: string, req: ChatRequest): AsyncGenerator<Chunk> {
  const contents: Content[] = [
    ...req.history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: req.question }] },
  ];
  const stream = await geminiClient(apiKey, p.baseUrl).models.generateContentStream({
    model: req.model,
    contents,
    config: { systemInstruction: req.system, abortSignal: req.signal, ...(req.thoughts ? { thinkingConfig: { includeThoughts: true } } : {}) },
  });
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      if (part.thought) yield { type: "thinking" };
      else if (part.text) yield { type: "text", text: part.text };
    }
  }
}

const base = (p: ProviderConfig) => p.baseUrl.replace(/\/+$/, "");

async function httpError(res: Response, who: string): Promise<ProviderError> {
  const text = await res.text().catch(() => "");
  let message = text.replace(/\s+/g, " ").slice(0, 300);
  try {
    const j = JSON.parse(text);
    message = j.error?.message ?? j.message ?? j.error ?? message;
  } catch {
    // no era JSON
  }
  return new ProviderError(`${who} respondió ${res.status}: ${String(message).slice(0, 300)}`, res.status);
}

/** Eventos server-sent (SSE) de una respuesta en streaming. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let m = /\r?\n\r?\n/.exec(buffer); m; m = /\r?\n\r?\n/.exec(buffer)) {
      const raw = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      let event: string | undefined;
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

async function* openaiStream(p: ProviderConfig, apiKey: string, req: ChatRequest): AsyncGenerator<Chunk> {
  const res = await fetch(`${base(p)}/chat/completions`, {
    method: "POST",
    signal: req.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(p.id === "openrouter" ? { "x-title": "Analizador de chats" } : {}),
    },
    body: JSON.stringify({
      model: req.model,
      stream: true,
      messages: [
        { role: "system", content: req.system },
        ...req.history.map((t) => ({ role: t.role, content: t.text })),
        { role: "user", content: req.question },
      ],
    }),
  });
  if (!res.ok || !res.body) throw await httpError(res, p.name);
  for await (const { data } of sse(res.body)) {
    if (data === "[DONE]") return;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue; // comentarios o líneas de keep-alive
    }
    if (j.error) throw new ProviderError(`${p.name}: ${j.error.message ?? JSON.stringify(j.error).slice(0, 200)}`, Number(j.error.code) || 500);
    const delta = j.choices?.[0]?.delta;
    if (delta?.reasoning_content || delta?.reasoning) yield { type: "thinking" };
    if (typeof delta?.content === "string" && delta.content) yield { type: "text", text: delta.content };
  }
}

async function* anthropicStream(p: ProviderConfig, apiKey: string, req: ChatRequest): AsyncGenerator<Chunk> {
  const res = await fetch(`${base(p)}/v1/messages`, {
    method: "POST",
    signal: req.signal,
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 16000,
      stream: true,
      system: req.system,
      messages: [...req.history.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: req.question }],
    }),
  });
  if (!res.ok || !res.body) throw await httpError(res, p.name);
  let wrote = false;
  for await (const { data } of sse(res.body)) {
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.type === "error") {
      const status = j.error?.type === "overloaded_error" ? 529 : j.error?.type === "rate_limit_error" ? 429 : 500;
      throw new ProviderError(`${p.name}: ${j.error?.message ?? "error"}`, status);
    }
    if (j.type === "content_block_delta" && j.delta?.type === "text_delta" && j.delta.text) {
      wrote = true;
      yield { type: "text", text: j.delta.text };
    } else if (!wrote && (j.type === "ping" || j.delta?.type === "thinking_delta")) {
      yield { type: "thinking" };
    }
  }
}

// ---------- modelos disponibles y prueba de conexión (no gastan cuota de generación) ----------

export async function listModels(p: ProviderConfig, apiKey: string): Promise<string[]> {
  const signal = AbortSignal.timeout(12_000);
  if (p.kind === "gemini") {
    const names: string[] = [];
    const pager = await geminiClient(apiKey, p.baseUrl).models.list({ config: { pageSize: 200, abortSignal: signal } });
    for await (const m of pager) {
      const actions = m.supportedActions ?? [];
      if (m.name && (actions.includes("generateContent") || actions.includes("bidiGenerateContent"))) names.push(m.name.replace(/^models\//, ""));
    }
    return names;
  }
  const res =
    p.kind === "anthropic"
      ? await fetch(`${base(p)}/v1/models?limit=1000`, { signal, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } })
      : await fetch(`${base(p)}/models`, { signal, headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw await httpError(res, p.name);
  const json = (await res.json()) as { data?: { id?: string }[] };
  return (json.data ?? []).map((m) => m.id ?? "").filter(Boolean).sort();
}

export type ConnectionState = "ok" | "invalid" | "error";

export async function testProvider(p: ProviderConfig, apiKey: string): Promise<{ state: ConnectionState; message: string; models: string[] }> {
  try {
    const models = await listModels(p, apiKey);
    return { state: "ok", message: `Conectado · ${models.length} modelos disponibles`, models };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const invalid = status === 401 || status === 403 || /API key not valid|invalid.*key|unauthorized/i.test(String((err as Error).message));
    return { state: invalid ? "invalid" : "error", message: invalid ? "Clave inválida" : String((err as Error).message).slice(0, 200), models: [] };
  }
}
