import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DATA_DIR, TIMEZONE } from "./config.js";
import { FAMILIES, getSettings, modelKey, parseKey, provider, type ModelLimit } from "./settings.js";

// Presupuesto local de requests, por modelo y por día de cuota de Google.
//
// Google corta por requests por día (RPD) y por minuto (RPM), por modelo. Un 429 de cuota diaria
// no se libera reintentando: cada intento extra es un request desperdiciado. Así que antes de cada
// llamada se consulta este presupuesto, y un 429 diario marca el modelo como agotado hasta el reset.
// Los límites se ajustan en el Panel de control (0 = sin límite; lo normal en proveedores pagos).
// El archivo vive en data/ y lo comparten la interfaz web y la CLI. Las claves de Gemini van sin
// prefijo (compatibilidad con el historial de uso); las de otros proveedores, "proveedor:modelo".

const USAGE_PATH = resolve(DATA_DIR, "gemini-usage.json");
const QUOTA_TIMEZONE = "America/Los_Angeles"; // la cuota diaria de Gemini se renueva a medianoche del Pacífico

export type Purpose = "transcribe" | "qa";

interface ModelUsage {
  requests: number;
  exhausted: boolean; // el proveedor ya respondió "cuota diaria agotada"
  lastRequestAt: number; // epoch ms, para espaciar según RPM entre procesos
}

interface UsageFile {
  day: string;
  models: Record<string, ModelUsage>;
}

export class QuotaError extends Error {}

function quotaDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: QUOTA_TIMEZONE }).format(date);
}

/** Próxima medianoche del Pacífico, expresada en la zona horaria local (p. ej. "02:00" en Colombia). */
export function nextResetLabel(): string {
  const now = Date.now();
  const today = quotaDay();
  let t = now;
  // Avanza hasta que cambia el día del Pacífico (resolución de 1 min: suficiente y sin aritmética de DST).
  for (let step = 60 * 60 * 1000; step >= 60 * 1000; step /= 60) {
    while (quotaDay(new Date(t + step)) === today) t += step;
  }
  const reset = new Date(t + 60 * 1000);
  return new Intl.DateTimeFormat("es-CO", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(reset);
}

async function load(): Promise<UsageFile> {
  const raw = await readFile(USAGE_PATH, "utf-8").catch(() => null);
  const file: UsageFile = raw ? JSON.parse(raw) : { day: quotaDay(), models: {} };
  if (file.day !== quotaDay()) return { day: quotaDay(), models: {} };
  return file;
}

async function save(file: UsageFile) {
  await mkdir(dirname(USAGE_PATH), { recursive: true });
  const tmp = `${USAGE_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await rename(tmp, USAGE_PATH);
}

function entry(file: UsageFile, key: string): ModelUsage {
  return (file.models[key] ??= { requests: 0, exhausted: false, lastRequestAt: 0 });
}

/** Límites propios del modelo; si no tiene, los generales de Gemini o, en otros proveedores, sin límite. */
export function modelLimits(key: string): ModelLimit {
  const s = getSettings();
  const own = s.limits.models[key];
  if (own) return own;
  return provider(parseKey(key).provider)?.kind === "gemini" ? s.limits.geminiDefault : { daily: 0, rpm: 0 };
}

function limitFor(key: string, purpose: Purpose): number {
  const s = getSettings();
  const { daily } = modelLimits(key);
  if (!daily) return Infinity;
  // Si transcripción y preguntas comparten modelo, la transcripción deja libres los últimos requests.
  const primaryQa = s.chain[0] ? modelKey(s.chain[0]) : "";
  return purpose === "transcribe" && key === primaryQa ? Math.max(0, daily - s.limits.qaReserve) : daily;
}

// Serializa las reservas dentro del proceso (varias requests concurrentes de la web).
let chain: Promise<unknown> = Promise.resolve();

/** Reserva un request: espera el espaciado por RPM o falla con QuotaError si no queda presupuesto. */
export function acquire(key: string, purpose: Purpose): Promise<void> {
  const run = chain.then(async () => {
    const file = await load();
    const usage = entry(file, key);
    const limit = limitFor(key, purpose);

    if (usage.exhausted) {
      throw new QuotaError(`El proveedor informó que la cuota diaria de ${key} está agotada. Se renueva a las ${nextResetLabel()}.`);
    }
    const { daily, rpm } = modelLimits(key);
    if (usage.requests >= limit) {
      const reserve = limit < daily ? ` (se reservan ${daily - limit} para preguntas)` : "";
      throw new QuotaError(`Presupuesto diario de ${key} usado: ${usage.requests}/${daily}${reserve}. Se renueva a las ${nextResetLabel()}.`);
    }

    if (rpm > 0) {
      const wait = usage.lastRequestAt + 60_000 / rpm - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    usage.requests++;
    usage.lastRequestAt = Date.now();
    await save(file);
  });
  chain = run.catch(() => {});
  return run;
}

/** Cuenta un uso sin límite ni espaciado (sesiones Live): solo para mostrarlo en la interfaz. */
export function recordUse(key: string): Promise<void> {
  const run = chain.then(async () => {
    const file = await load();
    entry(file, key).requests++;
    await save(file);
  });
  chain = run.catch(() => {});
  return run;
}

export async function markExhausted(key: string) {
  const file = await load();
  entry(file, key).exhausted = true;
  await save(file);
}

export function isDailyQuotaError(err: unknown): boolean {
  return (err as { status?: number })?.status === 429 && /PerDay/i.test(String((err as Error)?.message));
}

/** Nombre corto para mostrar: sin el prefijo "gemini-" ni el del proveedor. */
export function modelLabel(key: string): string {
  const { provider: p, model } = parseKey(key);
  if (FAMILIES[model]) return FAMILIES[model].label;
  return p === "gemini" ? model.replace(/^gemini-/, "") : model;
}

/** Modelos que ya tuvieron pedidos hoy. */
export async function usedToday(): Promise<string[]> {
  const file = await load();
  return Object.keys(file.models).filter((k) => file.models[k].requests > 0 || file.models[k].exhausted);
}

/** Uso de hoy de varios modelos (para el Panel de control). */
export async function usageOf(keys: string[]) {
  const file = await load();
  return Object.fromEntries(
    keys.map((key) => [key, { requests: file.models[key]?.requests ?? 0, exhausted: file.models[key]?.exhausted ?? false, ...modelLimits(key) }]),
  );
}

/** `qaChain`: claves de los modelos de preguntas en orden (familias expandidas); los respaldos se muestran si se usaron hoy. */
export async function usageSummary(qaChain: string[] = []) {
  const s = getSettings();
  const file = await load();
  const transcribeKey = s.transcribe ? modelKey(s.transcribe) : "";
  const liveKey = s.transcribeFallback ? modelKey(s.transcribeFallback) : "";
  const qaKey = qaChain[0] ?? "";
  const useOf = (key: string) =>
    key === transcribeKey && key === qaKey ? "notas de voz y preguntas" : key === transcribeKey ? "notas de voz" : key === qaKey ? "preguntas" : "preguntas (respaldo)";
  const usedFallbacks = qaChain.slice(1).filter((m) => (file.models[m]?.requests ?? 0) > 0 || file.models[m]?.exhausted);
  const models = [...new Set([transcribeKey, qaKey, ...usedFallbacks].filter(Boolean))].map((key) => ({
    model: key,
    label: modelLabel(key),
    use: useOf(key),
    ...modelLimits(key),
    requests: file.models[key]?.requests ?? 0,
    exhausted: file.models[key]?.exhausted ?? false,
  }));
  const live = liveKey
    ? [{ model: liveKey, label: modelLabel(liveKey), use: "respaldo Live", daily: null, rpm: null, requests: file.models[liveKey]?.requests ?? 0, exhausted: false }]
    : [];
  const allGemini = [...models, ...live].every((m) => provider(parseKey(m.model).provider)?.kind === "gemini");
  return { resetsAt: nextResetLabel(), title: allGemini ? "Cuota Gemini hoy" : "Uso de IA hoy", models: [...models, ...live] };
}
