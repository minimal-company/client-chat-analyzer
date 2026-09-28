import { resolve } from "node:path";
import { DATA_DIR, optionalEnv, positiveInt, TIMEZONE } from "./env.js";
import { getSettings, isLiveModel, provider, resolveSecret, type AppSettings } from "./settings.js";

// Configuración efectiva. Lo que se puede editar desde el Panel de control sale de settings.ts (que usa
// .env como valor por defecto); lo demás, directo de .env.

export { DATA_DIR, TIMEZONE };

export function chatwootConfig() {
  const { baseUrl, accountId } = getSettings().chatwoot;
  const apiToken = resolveSecret("chatwoot");
  if (!baseUrl) throw new Error("Falta la URL de Chatwoot (Panel de control › Conexiones CRM, o CHATWOOT_BASE_URL en .env)");
  if (!accountId) throw new Error("Falta el ID de cuenta de Chatwoot (Panel de control › Conexiones CRM, o CHATWOOT_ACCOUNT_ID en .env)");
  if (!apiToken) throw new Error("Falta el token de Chatwoot (Panel de control › Conexiones CRM, o CHATWOOT_API_TOKEN en .env)");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), accountId, apiToken };
}

export type TranscribeStrategy = "batch" | "live" | "batch+live";

/**
 * batch: lotes con el modelo de notas de voz. live: sesiones Live (el modelo elegido es "-live").
 * batch+live: lotes y lo que falle, por Live (respaldo elegido en el panel).
 */
function transcribeSetup(s: AppSettings): { strategy: TranscribeStrategy; batchModel: string; liveModel: string } {
  const main = s.transcribe?.model || optionalEnv("GEMINI_TRANSCRIBE_MODEL", "gemini-flash-latest");
  const fallback = s.transcribeFallback?.model ?? "";
  if (isLiveModel(main)) return { strategy: "live", batchModel: "", liveModel: main };
  if (fallback && isLiveModel(fallback)) return { strategy: "batch+live", batchModel: main, liveModel: fallback };
  return { strategy: "batch", batchModel: main, liveModel: "" };
}

export function geminiConfig() {
  const s = getSettings();
  const L = s.limits;
  const apiKey = resolveSecret("provider:gemini");
  if (!apiKey) throw new Error("Falta la clave de Gemini (Panel de control › Modelos y API keys, o GEMINI_API_KEY en .env)");
  const t = transcribeSetup(s);
  return {
    apiKey,
    baseUrl: provider("gemini")?.baseUrl ?? "",
    transcribeModel: t.batchModel,
    transcribeLiveModel: t.liveModel,
    transcribeStrategy: t.strategy,
    // Pedidos diarios que la transcripción deja libres cuando comparte modelo con las preguntas.
    qaReserve: L.qaReserve,
    // Preguntas: tiempo máximo sin señales de vida al empezar (el razonamiento cuenta), tope total
    // sumando todos los modelos, y minutos que un modelo que falló pasa al final de la fila.
    qaFirstTokenTimeoutMs: L.firstTokenTimeoutSec * 1000,
    qaTotalTimeoutMs: L.totalTimeoutSec * 1000,
    qaCooldownMs: L.cooldownMin * 60 * 1000,
    // Notas de voz por request de transcripción, y cuántos lotes se envían en paralelo.
    batchSize: L.batchSize,
    batchMaxBytes: L.batchMaxMb * 1024 * 1024,
    transcribeConcurrency: L.transcribeConcurrency,
    // Respaldo por Live API: sesiones en paralelo, sesiones nuevas por minuto y velocidad de envío.
    liveConcurrency: L.liveConcurrency,
    liveRpm: L.liveRpm,
    liveSpeed: L.liveSpeed,
  };
}

/** Evolution API como segunda fuente (opcional): null si no tiene URL. */
export function evolutionConfig() {
  const { baseUrl, instance } = getSettings().evolution;
  if (!baseUrl) return null;
  const apiKey = resolveSecret("evolution");
  if (!apiKey) throw new Error("Falta la API key de Evolution (Panel de control › WhatsApp, o EVOLUTION_API_KEY en .env)");
  if (!instance) throw new Error("Falta la instancia de Evolution (Panel de control › WhatsApp, o EVOLUTION_INSTANCE en .env)");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, instance };
}

export function webConfig() {
  // WEB_USER / WEB_PASSWORD solo crean el primer usuario (si todavía no hay ninguno); después se
  // administran desde el Panel de control (Usuarios) o con `cca user ...`.
  const password = optionalEnv("WEB_PASSWORD", "");
  if (password && password.length < 10) throw new Error("WEB_PASSWORD debe tener al menos 10 caracteres");
  return {
    port: positiveInt("WEB_PORT", 8790),
    bootstrapUser: optionalEnv("WEB_USER", "admin"),
    bootstrapPassword: password || null,
    // Dirección pública (detrás de Cloudflare), p. ej. https://analizador.minimal-company.com
    publicUrl: optionalEnv("PUBLIC_URL", "").replace(/\/+$/, ""),
  };
}

export const TRANSCRIPTION_CACHE_DIR = resolve(DATA_DIR, "transcriptions");

export function historyPath(contactId: number): string {
  return resolve(DATA_DIR, `contact-${contactId}.txt`);
}

export function historyMetaPath(contactId: number): string {
  return resolve(DATA_DIR, `contact-${contactId}.meta.json`);
}

export function historyMessagesPath(contactId: number): string {
  return resolve(DATA_DIR, `contact-${contactId}.messages.json`);
}
