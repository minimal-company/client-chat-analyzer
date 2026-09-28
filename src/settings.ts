import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DATA_DIR, optionalEnv, positiveInt } from "./env.js";

// ---------------------------------------------------------------------------
// Configuración que se edita desde el Panel de control.
//   data/settings.json  proveedores, cadena de respaldo, modelo por tarea, límites, instrucciones,
//                       conexiones (sin secretos)
//   data/secrets.json   claves de API y tokens, cifrados con AES-256-GCM (clave: SETTINGS_SECRET)
// Mientras no se guarde nada desde el panel, todo sale de .env: desplegar esto no cambia el comportamiento.
// Se lee de forma síncrona con caché por fecha de modificación, porque también lo usa la CLI en otro
// contenedor y las funciones de configuración son síncronas.
// ---------------------------------------------------------------------------

export type ProviderKind = "gemini" | "openai" | "anthropic";

export interface ModelRef {
  provider: string;
  model: string; // nombre del modelo, o una familia de Gemini ("@flash", "@flash-lite")
}

export interface ProviderModel {
  id: string;
  enabled: boolean;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind; // dialecto de la API; "openai" = compatible con OpenAI (DeepSeek, OpenRouter, propios)
  name: string;
  subtitle: string;
  keyUrl: string;
  enabled: boolean;
  baseUrl: string;
  idleTimeoutSec: number; // tiempo máximo sin respuesta (entre fragmentos) antes de pasar al siguiente
  models: ProviderModel[];
  custom?: boolean;
}

/** 0 = sin límite. */
export interface ModelLimit {
  daily: number;
  rpm: number;
}

export interface Limits {
  models: Record<string, ModelLimit>; // por clave de modelo (ver modelKey)
  geminiDefault: ModelLimit; // modelos Gemini sin límite propio (p. ej. los que entran por familia)
  qaReserve: number; // pedidos diarios que la transcripción deja libres si comparte modelo con las preguntas
  firstTokenTimeoutSec: number;
  totalTimeoutSec: number;
  cooldownMin: number;
  batchSize: number;
  batchMaxMb: number;
  transcribeConcurrency: number;
  liveConcurrency: number;
  liveRpm: number;
  liveSpeed: number;
}

export interface AppSettings {
  providers: ProviderConfig[];
  chain: ModelRef[]; // orden en que se prueban los modelos para preguntas; el primero es el principal
  transcribe: ModelRef | null; // notas de voz: modelo principal (si es "-live", se usan sesiones Live)
  transcribeFallback: ModelRef | null; // respaldo Live cuando el principal transcribe por lotes
  limits: Limits;
  instructions: string; // contexto e instrucciones del negocio que se suman al analista
  chatwoot: { baseUrl: string; accountId: string };
  evolution: { baseUrl: string; instance: string };
}

export const FAMILIES: Record<string, { label: string; pattern: RegExp }> = {
  "@flash": { label: "Todos los Gemini Flash", pattern: /^gemini-(\d+(?:\.\d+)?)-flash(-preview)?$/ },
  "@flash-lite": { label: "Todos los Gemini Flash-Lite", pattern: /^gemini-(\d+(?:\.\d+)?)-flash-lite(-preview)?$/ },
};

const BUILTIN: Omit<ProviderConfig, "enabled" | "idleTimeoutSec" | "models">[] = [
  { id: "gemini", kind: "gemini", name: "Google Gemini", subtitle: "Google AI Studio", baseUrl: "https://generativelanguage.googleapis.com", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openai", kind: "openai", name: "OpenAI", subtitle: "ChatGPT · platform.openai.com", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", kind: "anthropic", name: "Anthropic", subtitle: "Claude · console.anthropic.com", baseUrl: "https://api.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "deepseek", kind: "openai", name: "DeepSeek", subtitle: "platform.deepseek.com", baseUrl: "https://api.deepseek.com", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "openrouter", kind: "openai", name: "OpenRouter", subtitle: "Muchos modelos con una sola clave", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/settings/keys" },
];

/** Variables de .env que sirven de respaldo para cada secreto. */
export const SECRET_ENV: Record<string, string> = {
  "provider:gemini": "GEMINI_API_KEY",
  "provider:openai": "OPENAI_API_KEY",
  "provider:anthropic": "ANTHROPIC_API_KEY",
  "provider:deepseek": "DEEPSEEK_API_KEY",
  "provider:openrouter": "OPENROUTER_API_KEY",
  chatwoot: "CHATWOOT_API_TOKEN",
  evolution: "EVOLUTION_API_KEY",
};

// ---------- claves de modelo ----------

/** Clave con que se identifica un modelo en la cuota y en los eventos: Gemini sin prefijo (compatibilidad). */
export const modelKey = (r: ModelRef) => (r.provider === "gemini" ? r.model : `${r.provider}:${r.model}`);

export function parseKey(key: string): ModelRef {
  const i = key.indexOf(":");
  if (i > 0) {
    const provider = key.slice(0, i);
    if (getSettings().providers.some((p) => p.id === provider)) return { provider, model: key.slice(i + 1) };
  }
  return { provider: "gemini", model: key };
}

export const isLiveModel = (model: string) => /-live\b|live-/i.test(model);
const isTranscribeOnly = (model: string) => /transcribe/i.test(model);

/** Qué admite cada modelo, para las etiquetas del panel y para filtrar las tareas. */
export function capabilities(ref: ModelRef): { text: boolean; audio: boolean } {
  if (FAMILIES[ref.model]) return { text: true, audio: false };
  const provider = getSettings().providers.find((p) => p.id === ref.provider);
  if (provider?.kind !== "gemini") return { text: true, audio: false };
  if (isTranscribeOnly(ref.model) || isLiveModel(ref.model)) return { text: false, audio: true };
  if (/tts|image|embedding|imagen|veo/i.test(ref.model)) return { text: false, audio: false };
  return { text: true, audio: !/lite/i.test(ref.model) };
}

// ---------- valores por defecto (desde .env) ----------

/** GEMINI_MODEL_LIMITS="modelo=diario/por-minuto,otro=diario/por-minuto". */
function parseModelLimits(raw: string): Record<string, ModelLimit> {
  const limits: Record<string, ModelLimit> = {};
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^=\s]+)\s*=\s*(\d+)\s*\/\s*(\d+)$/.exec(item);
    if (!m) throw new Error(`GEMINI_MODEL_LIMITS: "${item}" debe tener la forma modelo=diario/por-minuto`);
    limits[m[1]] = { daily: +m[2], rpm: +m[3] };
  }
  return limits;
}

function defaults(): AppSettings {
  const gemini = (model: string): ModelRef => ({ provider: "gemini", model });
  const qa = optionalEnv("GEMINI_QA_MODEL", "gemini-flash-latest");
  const batch = optionalEnv("GEMINI_TRANSCRIBE_MODEL", "gemini-flash-latest");
  const live = process.env.GEMINI_TRANSCRIBE_LIVE_MODEL?.trim() ?? "";
  const strategy = optionalEnv("GEMINI_TRANSCRIBE_STRATEGY", live ? "batch+live" : "batch");
  const fallbacks = (process.env.GEMINI_QA_FALLBACK_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const overrides = parseModelLimits(process.env.GEMINI_MODEL_LIMITS ?? "");
  const daily = positiveInt("GEMINI_DAILY_LIMIT", 20);
  const rpm = positiveInt("GEMINI_RPM", 5);

  const models: Record<string, ModelLimit> = {
    [qa]: { daily: positiveInt("GEMINI_QA_DAILY_LIMIT", daily), rpm: positiveInt("GEMINI_QA_RPM", rpm) },
    [batch]: { daily: positiveInt("GEMINI_TRANSCRIBE_DAILY_LIMIT", daily), rpm: positiveInt("GEMINI_TRANSCRIBE_RPM", rpm) },
    ...(live ? { [live]: { daily: 0, rpm: 0 } } : {}), // Live: sin límite diario (se espacia con liveRpm)
    ...overrides,
  };
  const geminiModels = [...new Set([qa, ...fallbacks.filter((f) => !FAMILIES[f]), batch, live, ...Object.keys(overrides)].filter(Boolean))];

  return {
    providers: BUILTIN.map((p) => ({
      ...p,
      enabled: true,
      idleTimeoutSec: p.id === "gemini" ? positiveInt("GEMINI_QA_IDLE_TIMEOUT_S", 60) : 90,
      models: p.id === "gemini" ? geminiModels.map((id) => ({ id, enabled: true })) : [],
    })),
    chain: [qa, ...fallbacks].filter((m, i, all) => all.indexOf(m) === i).map(gemini),
    transcribe: gemini(strategy === "live" && live ? live : batch),
    transcribeFallback: strategy === "batch+live" && live ? gemini(live) : null,
    limits: {
      models,
      geminiDefault: { daily, rpm },
      qaReserve: positiveInt("GEMINI_QA_RESERVE", 5, 0),
      firstTokenTimeoutSec: positiveInt("GEMINI_QA_FIRST_TOKEN_TIMEOUT_S", 20),
      totalTimeoutSec: positiveInt("GEMINI_QA_TOTAL_TIMEOUT_S", 300),
      cooldownMin: positiveInt("GEMINI_QA_COOLDOWN_MIN", 10),
      batchSize: positiveInt("GEMINI_BATCH_SIZE", 30),
      batchMaxMb: positiveInt("GEMINI_BATCH_MAX_MB", 3),
      transcribeConcurrency: positiveInt("GEMINI_TRANSCRIBE_CONCURRENCY", 3),
      liveConcurrency: positiveInt("GEMINI_LIVE_CONCURRENCY", 4),
      liveRpm: positiveInt("GEMINI_LIVE_RPM", 10),
      liveSpeed: positiveInt("GEMINI_LIVE_SPEED", 4),
    },
    instructions: "",
    chatwoot: { baseUrl: (process.env.CHATWOOT_BASE_URL ?? "").trim().replace(/\/+$/, ""), accountId: (process.env.CHATWOOT_ACCOUNT_ID ?? "").trim() },
    evolution: { baseUrl: (process.env.EVOLUTION_BASE_URL ?? "").trim().replace(/\/+$/, ""), instance: (process.env.EVOLUTION_INSTANCE ?? "").trim() },
  };
}

function merge(base: AppSettings, saved: Partial<AppSettings>): AppSettings {
  const savedProviders = saved.providers ?? [];
  const providers = [
    ...base.providers.map((p) => {
      const s = savedProviders.find((x) => x.id === p.id);
      // Nombre, dialecto y enlace de los proveedores incluidos los define el código, no el archivo.
      return s ? { ...p, enabled: s.enabled, baseUrl: s.baseUrl || p.baseUrl, idleTimeoutSec: s.idleTimeoutSec || p.idleTimeoutSec, models: s.models ?? p.models } : p;
    }),
    ...savedProviders.filter((p) => p.custom && !base.providers.some((b) => b.id === p.id)),
  ];
  return {
    ...base,
    providers,
    chain: saved.chain ?? base.chain,
    transcribe: saved.transcribe !== undefined ? saved.transcribe : base.transcribe,
    transcribeFallback: saved.transcribeFallback !== undefined ? saved.transcribeFallback : base.transcribeFallback,
    limits: { ...base.limits, ...saved.limits, models: { ...base.limits.models, ...saved.limits?.models } },
    instructions: saved.instructions ?? base.instructions,
    chatwoot: { ...base.chatwoot, ...saved.chatwoot },
    evolution: { ...base.evolution, ...saved.evolution },
  };
}

// ---------- lectura y escritura ----------

const settingsFile = () => resolve(DATA_DIR, "settings.json");
const secretsFile = () => resolve(DATA_DIR, "secrets.json");

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function writeAtomic(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

let settingsCache: { mtimeMs: number; value: AppSettings } | null = null;

export function getSettings(): AppSettings {
  const m = mtime(settingsFile());
  if (settingsCache?.mtimeMs === m) return settingsCache.value;
  const saved = m >= 0 ? (JSON.parse(readFileSync(settingsFile(), "utf-8")) as Partial<AppSettings>) : {};
  const value = merge(defaults(), saved);
  settingsCache = { mtimeMs: m, value };
  return value;
}

export function saveSettings(value: AppSettings) {
  writeAtomic(settingsFile(), value);
  settingsCache = null;
}

export function provider(id: string): ProviderConfig | undefined {
  return getSettings().providers.find((p) => p.id === id);
}

// ---------- secretos cifrados ----------

interface SecretBox {
  iv: string;
  tag: string;
  data: string;
}

function masterKey(): Buffer | null {
  const raw = process.env.SETTINGS_SECRET?.trim();
  return raw ? createHash("sha256").update(raw).digest() : null;
}

export const canEncrypt = () => !!masterKey();

let secretsCache: { mtimeMs: number; items: Record<string, SecretBox> } | null = null;

function readSecrets(): Record<string, SecretBox> {
  const m = mtime(secretsFile());
  if (secretsCache?.mtimeMs === m) return secretsCache.items;
  const items = m >= 0 ? ((JSON.parse(readFileSync(secretsFile(), "utf-8")).items ?? {}) as Record<string, SecretBox>) : {};
  secretsCache = { mtimeMs: m, items };
  return items;
}

let warnedKey = false;

/** El secreto guardado desde el panel (descifrado), o null. */
export function getSecret(name: string): string | null {
  const box = readSecrets()[name];
  const key = masterKey();
  if (!box || !key) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf-8");
  } catch {
    if (!warnedKey) console.error("[settings] No se pudo descifrar un secreto: ¿cambió SETTINGS_SECRET?");
    warnedKey = true;
    return null;
  }
}

/** Guarda (o borra, con null) un secreto. Requiere SETTINGS_SECRET. */
export function setSecret(name: string, value: string | null) {
  const items = { ...readSecrets() };
  if (value === null) delete items[name];
  else {
    const key = masterKey();
    if (!key) throw new Error("Falta SETTINGS_SECRET en .env: sin ella no se pueden guardar claves cifradas.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    items[name] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }
  writeAtomic(secretsFile(), { items });
  secretsCache = null;
}

/** Secreto efectivo: el del panel y, si no hay, el de .env. */
export function resolveSecret(name: string): string | null {
  return getSecret(name) ?? (SECRET_ENV[name] ? process.env[SECRET_ENV[name]]?.trim() || null : null);
}

export function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(8);
  return `${value.slice(0, 4)}${"•".repeat(Math.min(16, value.length - 8))}${value.slice(-4)}`;
}

/** Lo que el panel puede mostrar de un secreto: nunca el valor completo. */
export function secretInfo(name: string): { set: boolean; masked: string; source: "panel" | "env" | null } {
  const own = getSecret(name);
  if (own) return { set: true, masked: mask(own), source: "panel" };
  const env = SECRET_ENV[name] ? process.env[SECRET_ENV[name]]?.trim() : "";
  return env ? { set: true, masked: mask(env), source: "env" } : { set: false, masked: "", source: null };
}
