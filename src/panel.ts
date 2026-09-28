import { randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  addUser,
  closeOtherSessions,
  closeSession,
  listSessions,
  listUsers,
  recentAuthEvents,
  removeUser,
  resetUserPassword,
  updateUser,
  type Role,
  type User,
} from "./auth.js";
import { DATA_DIR } from "./config.js";
import { readHistoryMeta } from "./history.js";
import { baseInstructions } from "./llm.js";
import { listModels, testProvider, type ConnectionState } from "./providers.js";
import { modelLabel, nextResetLabel, usageOf, usedToday } from "./quota.js";
import {
  canEncrypt,
  capabilities,
  FAMILIES,
  getSettings,
  modelKey,
  parseKey,
  resolveSecret,
  saveSettings,
  secretInfo,
  setSecret,
  type AppSettings,
  type Limits,
  type ModelRef,
  type ProviderConfig,
} from "./settings.js";

// API del Panel de control (/api/panel/*). Solo para administradores; el servidor ya lo verificó.

class PanelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = (res: ServerResponse, status: number, body: unknown) => void;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  user: User;
  token: string;
  body: () => Promise<any>;
  send: Json;
}

// ---------- estado de las conexiones (se prueban al abrir el panel; caché de 10 min) ----------

type Status = { state: ConnectionState | "unset" | "off"; message: string; at: number };
const statusCache = new Map<string, Status>();
const FRESH_MS = 10 * 60 * 1000;

async function providerStatus(p: ProviderConfig): Promise<Status> {
  const key = resolveSecret(`provider:${p.id}`);
  if (!key) return { state: "unset", message: "Sin clave", at: Date.now() };
  const cached = statusCache.get(`provider:${p.id}`);
  if (cached && Date.now() - cached.at < FRESH_MS) return p.enabled ? cached : { ...cached, state: cached.state === "ok" ? "off" : cached.state };
  const r = await testProvider(p, key);
  const status = { state: r.state, message: r.message, at: Date.now() };
  statusCache.set(`provider:${p.id}`, status);
  if (r.state === "ok") catalogCache.set(`${p.id}|${key}`, { at: Date.now(), models: r.models });
  return p.enabled ? status : { ...status, state: status.state === "ok" ? "off" : status.state };
}

async function chatwootStatus(candidate?: { baseUrl?: string; accountId?: string; token?: string }): Promise<Status> {
  const s = getSettings().chatwoot;
  const baseUrl = (candidate?.baseUrl ?? s.baseUrl).replace(/\/+$/, "");
  const accountId = candidate?.accountId ?? s.accountId;
  const token = candidate?.token || resolveSecret("chatwoot");
  if (!baseUrl || !accountId || !token) return { state: "unset", message: "Falta completar la conexión", at: Date.now() };
  if (!candidate) {
    const cached = statusCache.get("chatwoot");
    if (cached && Date.now() - cached.at < FRESH_MS) return cached;
  }
  let status: Status;
  try {
    const res = await fetch(`${baseUrl}/api/v1/profile`, { headers: { api_access_token: token }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) status = { state: "invalid", message: "Token inválido", at: Date.now() };
    else if (!res.ok) status = { state: "error", message: `Chatwoot respondió ${res.status}`, at: Date.now() };
    else {
      const profile = (await res.json()) as { name?: string; accounts?: { id: number; name: string; role: string }[] };
      const account = profile.accounts?.find((a) => String(a.id) === String(accountId));
      status = account
        ? { state: "ok", message: `Conectado como ${profile.name ?? "?"} · cuenta «${account.name}» (${account.role === "administrator" ? "administrador" : account.role})`, at: Date.now() }
        : { state: "error", message: `El token no tiene acceso a la cuenta ${accountId}`, at: Date.now() };
    }
  } catch (err) {
    status = { state: "error", message: `No se pudo conectar: ${(err as Error).message.slice(0, 120)}`, at: Date.now() };
  }
  if (!candidate) statusCache.set("chatwoot", status);
  return status;
}

async function evolutionStatus(candidate?: { baseUrl?: string; instance?: string; key?: string }): Promise<Status & { profile?: string }> {
  const s = getSettings().evolution;
  const baseUrl = (candidate?.baseUrl ?? s.baseUrl).replace(/\/+$/, "");
  const instance = candidate?.instance ?? s.instance;
  const key = candidate?.key || resolveSecret("evolution");
  if (!baseUrl || !instance || !key) return { state: "unset", message: "Falta completar la conexión", at: Date.now() };
  if (!candidate) {
    const cached = statusCache.get("evolution");
    if (cached && Date.now() - cached.at < FRESH_MS) return cached;
  }
  let status: Status & { profile?: string };
  try {
    const signal = AbortSignal.timeout(10_000);
    const res = await fetch(`${baseUrl}/instance/connectionState/${encodeURIComponent(instance)}`, { headers: { apikey: key }, signal });
    if (res.status === 401 || res.status === 403) status = { state: "invalid", message: "API key inválida", at: Date.now() };
    else if (res.status === 404) status = { state: "error", message: `No existe la instancia «${instance}»`, at: Date.now() };
    else if (!res.ok) status = { state: "error", message: `Evolution respondió ${res.status}`, at: Date.now() };
    else {
      const j = (await res.json()) as { instance?: { state?: string }; state?: string };
      const state = j.instance?.state ?? j.state ?? "?";
      let profile: string | undefined;
      const info = await fetch(`${baseUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`, { headers: { apikey: key }, signal }).catch(() => null);
      if (info?.ok) {
        const list = (await info.json().catch(() => [])) as { profileName?: string; ownerJid?: string; number?: string }[];
        const it = Array.isArray(list) ? list[0] : undefined;
        const number = (it?.ownerJid ?? it?.number ?? "").replace(/@.*/, "");
        profile = [it?.profileName, number ? `+${number}` : ""].filter(Boolean).join(" · ") || undefined;
      }
      status =
        state === "open"
          ? { state: "ok", message: "WhatsApp conectado", at: Date.now(), profile }
          : { state: "error", message: state === "connecting" ? "Conectando con WhatsApp…" : "WhatsApp desconectado: vuelva a escanear el código QR en Evolution", at: Date.now(), profile };
    }
  } catch (err) {
    status = { state: "error", message: `No se pudo conectar: ${(err as Error).message.slice(0, 120)}`, at: Date.now() };
  }
  if (!candidate) statusCache.set("evolution", status);
  return status;
}

// ---------- catálogo de modelos de cada proveedor ----------

const catalogCache = new Map<string, { at: number; models: string[] }>();

async function catalog(p: ProviderConfig, key: string): Promise<string[]> {
  const id = `${p.id}|${key}`;
  const cached = catalogCache.get(id);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.models;
  const models = await listModels(p, key);
  catalogCache.set(id, { at: Date.now(), models });
  return models;
}

// ---------- estado completo para la interfaz ----------

async function listExports() {
  const dir = resolve(DATA_DIR, "exports");
  const out: { contactId: number; name: string | null; audios: number; at: number }[] = [];
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const id = Number(/^contact-(\d+)$/.exec(entry)?.[1]);
    if (!id) continue;
    const files = await readdir(resolve(dir, entry)).catch(() => [] as string[]);
    const chat = await stat(resolve(dir, entry, "_chat.txt")).catch(() => null);
    out.push({
      contactId: id,
      name: (await readHistoryMeta(id).catch(() => null))?.name ?? null,
      audios: files.filter((f) => /\.(opus|ogg|oga|m4a|mp3|aac|amr|wav)$/i.test(f)).length,
      at: chat?.mtimeMs ?? 0,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

async function panelState() {
  const s = getSettings();
  const used = await usedToday();
  const providers = await Promise.all(
    s.providers.map(async (p) => {
      // Además de los modelos agregados, los que se usaron hoy por una familia (p. ej. "Todos los Flash").
      const extra = used.filter((k) => parseKey(k).provider === p.id && !p.models.some((m) => modelKey({ provider: p.id, model: m.id }) === k));
      const rows = [...p.models.map((m) => ({ ...m, auto: false })), ...extra.map((k) => ({ id: parseKey(k).model, enabled: true, auto: true }))];
      const keys = rows.map((m) => modelKey({ provider: p.id, model: m.id }));
      const usage = await usageOf(keys);
      return {
        id: p.id,
        kind: p.kind,
        name: p.name,
        subtitle: p.subtitle,
        keyUrl: p.keyUrl,
        custom: !!p.custom,
        enabled: p.enabled,
        baseUrl: p.baseUrl,
        idleTimeoutSec: p.idleTimeoutSec,
        key: secretInfo(`provider:${p.id}`),
        status: await providerStatus(p).catch((err) => ({ state: "error", message: String(err.message).slice(0, 160), at: Date.now() })),
        models: rows.map((m) => {
          const key = modelKey({ provider: p.id, model: m.id });
          return { id: m.id, key, enabled: m.enabled, auto: m.auto, caps: capabilities({ provider: p.id, model: m.id }), usage: usage[key] };
        }),
      };
    }),
  );
  const [chatwoot, evolution, exports] = await Promise.all([chatwootStatus(), evolutionStatus(), listExports()]);
  const describe = (ref: ModelRef | null) => (ref ? { ...ref, key: modelKey(ref), label: modelLabel(modelKey(ref)), family: !!FAMILIES[ref.model] } : null);
  return {
    canEncrypt: canEncrypt(),
    providers,
    families: Object.entries(FAMILIES).map(([id, f]) => ({ id, label: f.label })),
    chain: s.chain.map(describe),
    transcribe: describe(s.transcribe),
    transcribeFallback: describe(s.transcribeFallback),
    limits: s.limits,
    limitUsage: await usageOf(Object.keys(s.limits.models)),
    resetsAt: nextResetLabel(),
    instructions: { extra: s.instructions, base: baseInstructions() },
    chatwoot: { ...s.chatwoot, token: secretInfo("chatwoot"), status: chatwoot },
    evolution: { ...s.evolution, key: secretInfo("evolution"), status: evolution },
    exports,
  };
}

// ---------- validación ----------

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function httpUrl(v: unknown, what: string): string {
  const url = str(v, 300).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new PanelError(400, `${what}: escriba una URL que empiece con http:// o https://`);
  return url;
}

function int(v: unknown, what: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new PanelError(400, `${what}: debe ser un número entero entre ${min} y ${max}.`);
  return n;
}

function modelRef(v: any, s: AppSettings, what: string): ModelRef {
  const provider = str(v?.provider, 64);
  const model = str(v?.model, 200);
  const p = s.providers.find((x) => x.id === provider);
  if (!p || !model) throw new PanelError(400, `${what}: modelo inválido.`);
  if (FAMILIES[model] && p.kind !== "gemini") throw new PanelError(400, `${what}: las familias solo existen en Gemini.`);
  return { provider, model };
}

function storeSecret(name: string, value: unknown) {
  if (value === undefined) return;
  const v = value === null ? "" : str(value, 4000);
  if (v && !canEncrypt()) throw new PanelError(400, "Falta SETTINGS_SECRET en el .env del servidor: sin ella las claves no se pueden guardar cifradas.");
  setSecret(name, v || null);
  statusCache.delete(name);
}

// ---------- guardado por sección ----------

function saveAi(input: any) {
  const s = getSettings();
  const providers = s.providers.map((p) => {
    const v = (input.providers ?? []).find((x: any) => x?.id === p.id);
    if (!v) return p;
    const models: { id: string; enabled: boolean }[] = [];
    for (const m of Array.isArray(v.models) ? v.models : []) {
      const id = str(m?.id, 200);
      if (id && !models.some((x) => x.id === id)) models.push({ id, enabled: m?.enabled !== false });
    }
    return {
      ...p,
      enabled: v.enabled !== false,
      baseUrl: httpUrl(v.baseUrl ?? p.baseUrl, `URL base de ${p.name}`),
      idleTimeoutSec: int(v.idleTimeoutSec ?? p.idleTimeoutSec, `Tiempo máximo sin respuesta de ${p.name}`, 5, 600),
      models,
    };
  });
  const next: AppSettings = { ...s, providers };
  if (input.chain !== undefined) {
    if (!Array.isArray(input.chain) || input.chain.length === 0) throw new PanelError(400, "La cadena de respaldo necesita al menos un modelo.");
    const chain = input.chain.slice(0, 40).map((r: any) => modelRef(r, next, "Cadena de respaldo"));
    next.chain = chain.filter((r: ModelRef, i: number) => chain.findIndex((x: ModelRef) => modelKey(x) === modelKey(r)) === i);
  }
  if (input.transcribe !== undefined) {
    const t = modelRef(input.transcribe, next, "Transcripción de notas de voz");
    if (next.providers.find((p) => p.id === t.provider)?.kind !== "gemini") throw new PanelError(400, "Las notas de voz solo se pueden transcribir con Gemini.");
    next.transcribe = t;
  }
  if (input.transcribeFallback !== undefined) {
    next.transcribeFallback = input.transcribeFallback ? modelRef(input.transcribeFallback, next, "Respaldo de notas de voz") : null;
  }
  // Primero las claves: si falta SETTINGS_SECRET, no se guarda nada a medias.
  for (const [id, value] of Object.entries(input.keys ?? {})) {
    if (!s.providers.some((p) => p.id === id)) continue;
    if (value !== undefined && value !== null && typeof value === "string" && value.trim() && !canEncrypt()) {
      throw new PanelError(400, "Falta SETTINGS_SECRET en el .env del servidor: sin ella las claves no se pueden guardar cifradas.");
    }
  }
  for (const [id, value] of Object.entries(input.keys ?? {})) if (s.providers.some((p) => p.id === id)) storeSecret(`provider:${id}`, value);
  saveSettings(next);
  for (const p of providers) {
    const before = s.providers.find((x) => x.id === p.id);
    if (before?.baseUrl !== p.baseUrl || input.keys?.[p.id] !== undefined) statusCache.delete(`provider:${p.id}`);
  }
}

function saveLimits(input: any) {
  const s = getSettings();
  const L = s.limits;
  const models: Limits["models"] = {};
  for (const [key, v] of Object.entries((input.models ?? L.models) as Record<string, any>)) {
    if (!key || key.length > 260) continue;
    models[key] = { daily: int(v?.daily, `Pedidos por día de ${key}`, 0, 1_000_000), rpm: int(v?.rpm, `Pedidos por minuto de ${key}`, 0, 100_000) };
  }
  const n = (k: keyof Limits, what: string, min: number, max: number) => (input[k] === undefined ? (L[k] as number) : int(input[k], what, min, max));
  const limits: Limits = {
    models,
    geminiDefault: input.geminiDefault
      ? { daily: int(input.geminiDefault.daily, "Pedidos por día (otros modelos de Gemini)", 0, 1_000_000), rpm: int(input.geminiDefault.rpm, "Pedidos por minuto (otros modelos de Gemini)", 0, 100_000) }
      : L.geminiDefault,
    qaReserve: n("qaReserve", "Reserva para preguntas", 0, 10_000),
    firstTokenTimeoutSec: n("firstTokenTimeoutSec", "Espera de la primera respuesta", 5, 600),
    totalTimeoutSec: n("totalTimeoutSec", "Espera total por pregunta", 30, 1800),
    cooldownMin: n("cooldownMin", "Pausa de un modelo que falló", 0, 1440),
    batchSize: n("batchSize", "Notas de voz por lote", 1, 200),
    batchMaxMb: n("batchMaxMb", "Tamaño máximo por lote", 1, 18),
    transcribeConcurrency: n("transcribeConcurrency", "Lotes en paralelo", 1, 20),
    liveConcurrency: n("liveConcurrency", "Sesiones Live en paralelo", 1, 20),
    liveRpm: n("liveRpm", "Sesiones Live por minuto", 1, 600),
    liveSpeed: n("liveSpeed", "Velocidad de envío Live", 1, 16),
  };
  saveSettings({ ...s, limits });
}

// ---------- rutas ----------

export async function handlePanel(ctx: Ctx): Promise<boolean> {
  const { req, res, path, send } = ctx;
  const method = req.method ?? "GET";
  const s = getSettings();

  if (method === "GET" && path === "/api/panel/state") return send(res, 200, await panelState()), true;

  if (method === "PUT" && path === "/api/panel/ai") {
    saveAi(await ctx.body());
    return send(res, 200, await panelState()), true;
  }
  if (method === "POST" && path === "/api/panel/providers") {
    const b = await ctx.body();
    const name = str(b.name, 60);
    if (!name) throw new PanelError(400, "Escriba un nombre para el proveedor.");
    const baseUrl = httpUrl(b.baseUrl, "URL base");
    const id = `custom-${randomBytes(3).toString("hex")}`;
    const host = new URL(baseUrl).host;
    saveSettings({
      ...s,
      providers: [...s.providers, { id, kind: "openai", name, subtitle: `Compatible con OpenAI · ${host}`, keyUrl: "", enabled: true, baseUrl, idleTimeoutSec: 90, models: [], custom: true }],
    });
    if (b.key) storeSecret(`provider:${id}`, b.key);
    return send(res, 201, { id }), true;
  }
  const providerRoute = /^\/api\/panel\/providers\/([\w-]+)(?:\/(test|models))?$/.exec(path);
  if (providerRoute) {
    const p = s.providers.find((x) => x.id === providerRoute[1]);
    if (!p) throw new PanelError(404, "Proveedor no encontrado.");
    if (method === "DELETE" && !providerRoute[2]) {
      if (!p.custom) throw new PanelError(400, "Solo se pueden quitar los proveedores agregados a mano.");
      saveSettings({
        ...s,
        providers: s.providers.filter((x) => x.id !== p.id),
        chain: s.chain.filter((r) => r.provider !== p.id),
        transcribeFallback: s.transcribeFallback?.provider === p.id ? null : s.transcribeFallback,
      });
      setSecret(`provider:${p.id}`, null);
      return send(res, 200, { ok: true }), true;
    }
    if (method === "POST" && providerRoute[2] === "test") {
      const b = await ctx.body();
      const candidate = { ...p, baseUrl: b.baseUrl ? httpUrl(b.baseUrl, "URL base") : p.baseUrl };
      const key = str(b.key, 4000) || resolveSecret(`provider:${p.id}`);
      if (!key) return send(res, 200, { state: "unset", message: "Escriba una clave para probar.", models: [] }), true;
      const r = await testProvider(candidate, key);
      if (!b.key && !b.baseUrl) statusCache.set(`provider:${p.id}`, { state: r.state, message: r.message, at: Date.now() });
      if (r.state === "ok") catalogCache.set(`${p.id}|${key}`, { at: Date.now(), models: r.models });
      return send(res, 200, r), true;
    }
    if (method === "GET" && providerRoute[2] === "models") {
      const key = resolveSecret(`provider:${p.id}`);
      if (!key) throw new PanelError(400, "Guarde primero una clave para este proveedor.");
      return send(res, 200, { models: await catalog(p, key) }), true;
    }
  }

  if (method === "PUT" && path === "/api/panel/limits") {
    saveLimits(await ctx.body());
    return send(res, 200, await panelState()), true;
  }
  if (method === "PUT" && path === "/api/panel/instructions") {
    const b = await ctx.body();
    if (typeof b.extra !== "string" || b.extra.length > 8000) throw new PanelError(400, "Las instrucciones deben tener como máximo 8.000 caracteres.");
    saveSettings({ ...s, instructions: b.extra.trim() });
    return send(res, 200, { ok: true }), true;
  }

  if (path === "/api/panel/chatwoot" && method === "PUT") {
    const b = await ctx.body();
    const accountId = str(b.accountId, 20);
    if (!/^\d+$/.test(accountId)) throw new PanelError(400, "El ID de cuenta debe ser un número.");
    const chatwoot = { baseUrl: httpUrl(b.baseUrl, "URL de Chatwoot"), accountId };
    storeSecret("chatwoot", b.token);
    saveSettings({ ...s, chatwoot });
    statusCache.delete("chatwoot");
    return send(res, 200, { status: await chatwootStatus() }), true;
  }
  if (path === "/api/panel/chatwoot/test" && method === "POST") {
    const b = await ctx.body();
    return send(res, 200, await chatwootStatus({ baseUrl: b.baseUrl ? httpUrl(b.baseUrl, "URL de Chatwoot") : undefined, accountId: str(b.accountId, 20) || undefined, token: str(b.token, 4000) || undefined })), true;
  }
  if (path === "/api/panel/whatsapp" && method === "PUT") {
    const b = await ctx.body();
    const baseUrl = str(b.baseUrl, 300) ? httpUrl(b.baseUrl, "URL de Evolution") : "";
    const instance = str(b.instance, 100);
    if (baseUrl && !instance) throw new PanelError(400, "Escriba el nombre de la instancia de Evolution.");
    storeSecret("evolution", b.key);
    saveSettings({ ...s, evolution: { baseUrl, instance } });
    statusCache.delete("evolution");
    return send(res, 200, { status: await evolutionStatus() }), true;
  }
  if (path === "/api/panel/whatsapp/test" && method === "POST") {
    const b = await ctx.body();
    return send(res, 200, await evolutionStatus({ baseUrl: b.baseUrl ? httpUrl(b.baseUrl, "URL de Evolution") : undefined, instance: str(b.instance, 100) || undefined, key: str(b.key, 4000) || undefined })), true;
  }

  if (path === "/api/panel/users" && method === "GET") return send(res, 200, await listUsers()), true;
  if (path === "/api/panel/users" && method === "POST") {
    const b = await ctx.body();
    const password = await addUser(b.username, b.name, (b.role === "admin" ? "admin" : "analista") as Role);
    return send(res, 201, { password }), true;
  }
  const userRoute = /^\/api\/panel\/users\/([^/]+)(\/reset)?$/.exec(path);
  if (userRoute) {
    const username = decodeURIComponent(userRoute[1]);
    if (method === "POST" && userRoute[2]) return send(res, 200, { password: await resetUserPassword(username) }), true;
    if (method === "PUT" && !userRoute[2]) {
      const b = await ctx.body();
      if (username === ctx.user.username && b.role && b.role !== "admin") throw new PanelError(400, "No puede quitarse a sí mismo el rol de administrador.");
      await updateUser(username, { name: b.name, role: b.role });
      return send(res, 200, { ok: true }), true;
    }
    if (method === "DELETE" && !userRoute[2]) {
      if (username === ctx.user.username) throw new PanelError(400, "No puede borrar su propio usuario.");
      await removeUser(username);
      return send(res, 200, { ok: true }), true;
    }
  }

  if (path === "/api/panel/security" && method === "GET") {
    const [sessions, events] = await Promise.all([listSessions(ctx.token), recentAuthEvents(60)]);
    return send(res, 200, { sessions, events }), true;
  }
  const sessionRoute = /^\/api\/panel\/sessions\/([0-9a-f]{16})$/.exec(path);
  if (sessionRoute && method === "DELETE") {
    await closeSession(sessionRoute[1]);
    return send(res, 200, { ok: true }), true;
  }
  if (path === "/api/panel/sessions/close-others" && method === "POST") {
    await closeOtherSessions(ctx.token);
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

