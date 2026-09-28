import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { downloadAttachment, getAllMessages, getContact, getContactConversations } from "./chatwoot.js";
import { DATA_DIR, evolutionConfig, geminiConfig, historyMessagesPath, historyMetaPath, historyPath, TIMEZONE, TRANSCRIPTION_CACHE_DIR } from "./config.js";
import { downloadEvolutionMedia, findContactMessages, MediaExpiredError, type EvolutionMessage } from "./evolution.js";
import { loadExport, mergeExport } from "./whatsapp-export.js";
import { transcribeBatch, type AudioItem } from "./gemini.js";
import { LiveQuotaError, transcribeLive } from "./live.js";
import { computeMetrics } from "./metrics.js";
import { QuotaError, recordUse } from "./quota.js";
import type { ChatwootAttachment, ChatwootContact, ChatwootConversation, ChatwootMessage } from "./types.js";

const EXTENSION_TO_MIME: Record<string, string> = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mp3",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  webm: "audio/webm",
};

const MESSAGE_TYPE = { incoming: 0, outgoing: 1, activity: 2, template: 3 } as const;

/** data_url sintético de los adjuntos que vienen de Evolution: "evolution:<id del mensaje en WhatsApp>". */
const EVOLUTION_URL_PREFIX = "evolution:";

/** Texto guardado para audios que WhatsApp ya no sirve: queda en caché para no reintentarlos. */
const EXPIRED_AUDIO_TEXT = "[audio no disponible: WhatsApp ya no tiene el archivo]";

function audioMimeType(attachment: ChatwootAttachment, downloaded: string | null): string {
  // "audio/ogg; codecs=opus" -> "audio/ogg"; Gemini espera el tipo sin parámetros.
  for (const candidate of [attachment.content_type, downloaded]) {
    const type = candidate?.split(";")[0].trim().toLowerCase();
    if (type === "audio/mpeg") return "audio/mp3";
    if (type?.startsWith("audio/")) return type;
  }
  return EXTENSION_TO_MIME[(attachment.extension ?? "").toLowerCase().replace(/^\./, "")] ?? "audio/ogg";
}

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatDate(epochSeconds: number): string {
  const p = Object.fromEntries(dateFormat.formatToParts(new Date(epochSeconds * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function senderLabel(message: ChatwootMessage): string {
  const origin = message.origin === "whatsapp" ? " [solo en WhatsApp]" : "";
  if (message.message_type === MESSAGE_TYPE.incoming) return `Cliente${origin}`;
  const name = message.sender?.name?.trim();
  if (message.private) return name ? `Nota interna (${name})` : "Nota interna";
  if (message.sender?.type === "agent_bot") return `Bot${origin}`;
  return (name ? `Agente (${name})` : "Agente") + origin;
}

// ---------------------------------------------------------------------------
// Evolution como segunda fuente: mensajes que están en WhatsApp pero nunca llegaron a Chatwoot.
// ---------------------------------------------------------------------------

/** Convierte un mensaje de Evolution a la forma de un mensaje de Chatwoot. null si no es contenido. */
function fromEvolution(m: EvolutionMessage, contactName: string | null): ChatwootMessage | null {
  const x = m.message ?? {};
  const doc = x.documentMessage ?? x.documentWithCaptionMessage?.message?.documentMessage;
  let content: string | null | undefined = null;
  let attachment: Partial<ChatwootAttachment> | null = null;

  switch (m.messageType) {
    case "conversation":
      content = x.conversation;
      break;
    case "extendedTextMessage":
      content = x.extendedTextMessage?.text;
      break;
    case "imageMessage":
      attachment = { file_type: "image" };
      content = x.imageMessage?.caption;
      break;
    case "videoMessage":
      attachment = { file_type: "video" };
      content = x.videoMessage?.caption;
      break;
    case "audioMessage":
      attachment = { file_type: "audio", content_type: x.audioMessage?.mimetype, file_size: longToNumber(x.audioMessage?.fileLength) };
      break;
    case "documentMessage":
    case "documentWithCaptionMessage":
      attachment = { file_type: "file", extension: doc?.fileName?.includes(".") ? doc.fileName.split(".").pop() : null };
      content = doc?.caption;
      break;
    case "stickerMessage":
      attachment = { file_type: "sticker" };
      break;
    case "locationMessage":
      attachment = {
        file_type: "location",
        coordinates_lat: x.locationMessage?.degreesLatitude,
        coordinates_long: x.locationMessage?.degreesLongitude,
        fallback_title: x.locationMessage?.name ?? x.locationMessage?.address,
      };
      break;
    case "contactMessage":
      attachment = { file_type: "contact", fallback_title: x.contactMessage?.displayName };
      break;
    default:
      return null; // reacciones, ediciones, eventos internos de WhatsApp (secretEncryptedMessage, etc.)
  }
  if (!content?.trim() && !attachment) return null;

  return {
    id: 0,
    content: content ?? null,
    message_type: m.key.fromMe ? MESSAGE_TYPE.outgoing : MESSAGE_TYPE.incoming,
    private: false,
    created_at: Number(m.messageTimestamp),
    source_id: `WAID:${m.key.id}`,
    origin: "whatsapp",
    sender: m.key.fromMe ? { type: "user", name: "WhatsApp" } : { type: "contact", name: m.pushName ?? contactName ?? undefined },
    attachments: attachment ? [{ id: 0, data_url: `${EVOLUTION_URL_PREFIX}${m.key.id}`, ...attachment } as ChatwootAttachment] : [],
  };
}

/** WhatsApp manda los tamaños como Long de protobuf ({ low, high }) o como número/string. */
function longToNumber(value: unknown): number | null {
  if (value && typeof value === "object" && "low" in value) {
    const { low, high } = value as { low: number; high: number };
    return (high >>> 0) * 2 ** 32 + (low >>> 0);
  }
  return Number(value) || null;
}

/** Conversación de Chatwoot vigente en ese momento (la última creada antes), para las métricas. */
function conversationAt(conversations: ChatwootConversation[], at: number): number | undefined {
  const byStart = [...conversations].sort((a, b) => a.created_at - b.created_at);
  return [...byStart].reverse().find((c) => c.created_at <= at)?.id ?? byStart[0]?.id;
}

const normalize = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Mensajes de Evolution que no están en Chatwoot. El cruce principal es por id de WhatsApp
 * (Chatwoot guarda "WAID:<id>" en source_id). Los mensajes de Chatwoot sin WAID (p. ej. enviados
 * desde Chatwoot cuando Evolution no pudo anotar el id) se cruzan por tipo, contenido y ±2 minutos,
 * para no duplicarlos.
 */
function missingFromChatwoot(
  evolution: EvolutionMessage[],
  chatwoot: ChatwootMessage[],
  conversations: ChatwootConversation[],
  contactName: string | null,
): ChatwootMessage[] {
  const known = new Set(chatwoot.map((m) => m.source_id?.replace(/^WAID:/, "")).filter(Boolean));
  const withoutId = chatwoot.filter((m) => !m.source_id?.startsWith("WAID:") && m.message_type !== MESSAGE_TYPE.activity);
  const result: ChatwootMessage[] = [];
  for (const raw of evolution) {
    if (known.has(raw.key.id)) continue;
    const m = fromEvolution(raw, contactName);
    if (!m) continue;
    const duplicate = withoutId.some(
      (c) =>
        (c.message_type === MESSAGE_TYPE.incoming) === (m.message_type === MESSAGE_TYPE.incoming) &&
        Math.abs(c.created_at - m.created_at) <= 120 &&
        (normalize(c.content) === normalize(m.content) ||
          (c.attachments?.[0]?.file_type !== undefined && c.attachments?.[0]?.file_type === m.attachments?.[0]?.file_type)),
    );
    if (duplicate) continue;
    m.conversation_id = conversationAt(conversations, m.created_at);
    result.push(m);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Transcripción de notas de voz, con caché en disco: re-generar un historial solo transcribe los
// audios nuevos (o los que fallaron la vez anterior).
// ---------------------------------------------------------------------------

/** Clave estable de un audio: id en Chatwoot, "wa-<id de WhatsApp>" (Evolution) o "exp-<archivo>" (exportación). */
function audioKey(a: ChatwootAttachment): string {
  if (a.data_url.startsWith(EVOLUTION_URL_PREFIX)) return `wa-${a.data_url.slice(EVOLUTION_URL_PREFIX.length)}`;
  if (!a.data_url && a.local_path) return `exp-${basename(a.local_path)}`; // solo está en la exportación
  return String(a.id);
}

const cachePath = (key: string) => resolve(TRANSCRIPTION_CACHE_DIR, `${key}.txt`);

/**
 * Agrupa en lotes por cantidad y por tamaño total. Un audio más grande que el tope por lote va solo.
 * Los lotes se arman en orden cronológico, así si la cuota se corta quedan transcritos los más viejos.
 */
function makeBatches(audios: ChatwootAttachment[]): ChatwootAttachment[][] {
  const { batchSize, batchMaxBytes } = geminiConfig();
  const batches: ChatwootAttachment[][] = [];
  let current: ChatwootAttachment[] = [];
  let bytes = 0;
  for (const audio of audios) {
    const size = audio.file_size ?? 0;
    if (current.length > 0 && (current.length >= batchSize || bytes + size > batchMaxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(audio);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface TranscriptionResult {
  texts: Map<string, string>;
  failed: number; // se intentó y falló: se reintenta en la próxima actualización
  pending: number; // no se llegó a intentar (sin presupuesto, o respaldo no disponible)
  expired: number; // WhatsApp ya no tiene el archivo: no se va a poder transcribir
  quotaMessage?: string;
}

/** Ejecuta `worker` sobre cada elemento con hasta `concurrency` en paralelo. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

/** Intentos por audio cuando la sesión Live se corta por cuota por minuto. */
const LIVE_QUOTA_ATTEMPTS = 3;

/** Errores que dicen "este modelo no acepta este pedido": reintentar con el mismo no sirve. */
const isRejection = (err: unknown) => [400, 403, 404].includes((err as { status?: number })?.status ?? 0);

/**
 * Transcribe las notas de voz que no estén ya resueltas (texto de Chatwoot o caché en disco).
 *
 * 1. Modelo principal (GEMINI_TRANSCRIBE_MODEL): lotes de varios audios por request, varios lotes
 *    en paralelo, dentro del presupuesto diario.
 * 2. Respaldo Live (GEMINI_TRANSCRIBE_LIVE_MODEL): lo que el principal no resolvió, una sesión por
 *    audio, en paralelo. Si el principal se queda sin cuota, rechaza el pedido o falla dos veces
 *    seguidas, todo lo que quede va directo al respaldo sin gastar más requests.
 */
async function transcribeAll(audios: ChatwootAttachment[], log: Logger): Promise<TranscriptionResult> {
  await mkdir(TRANSCRIPTION_CACHE_DIR, { recursive: true });
  const { transcribeModel, transcribeStrategy, transcribeConcurrency, liveConcurrency } = geminiConfig();
  const transcribeLiveModel = transcribeStrategy === "batch" ? "" : geminiConfig().transcribeLiveModel;
  const texts = new Map<string, string>();
  const todo: ChatwootAttachment[] = [];

  for (const audio of audios) {
    if (!audio.data_url && !audio.local_path) continue;
    const key = audioKey(audio);
    const known = audio.transcribed_text?.trim() || (await readFile(cachePath(key), "utf-8").catch(() => null));
    // Un audio que WhatsApp ya no servía pero ahora llegó por la exportación se transcribe de nuevo.
    if (known && !(known === EXPIRED_AUDIO_TEXT && audio.local_path)) texts.set(key, known);
    else todo.push(audio);
  }
  const expiredBefore = [...texts.values()].filter((t) => t === EXPIRED_AUDIO_TEXT).length;
  if (todo.length === 0) return { texts, failed: 0, pending: 0, expired: expiredBefore };

  const save = async (key: string, text: string) => {
    texts.set(key, text);
    await writeFile(cachePath(key), text, "utf-8");
  };

  let failed = 0;
  let expired = expiredBefore;
  // Descargas compartidas entre las dos etapas, para no bajar dos veces el mismo audio. Devuelve null si
  // no se pudo: un archivo vencido en WhatsApp queda anotado para no reintentarlo nunca más.
  const downloads = new Map<string, Promise<AudioItem | null>>();
  const fetchAudio = (audio: ChatwootAttachment): Promise<AudioItem | null> => {
    const key = audioKey(audio);
    if (!downloads.has(key)) {
      const source = audio.local_path
        ? readFile(audio.local_path).then((data) => ({ data, contentType: null }))
        : audio.data_url.startsWith(EVOLUTION_URL_PREFIX)
          ? downloadEvolutionMedia(audio.data_url.slice(EVOLUTION_URL_PREFIX.length))
          : downloadAttachment(audio.data_url);
      downloads.set(
        key,
        source.then(
          ({ data, contentType }) => ({
            data,
            mimeType: audioMimeType(audio.local_path ? { ...audio, extension: extname(audio.local_path).slice(1) } : audio, contentType),
          }),
          async (err: Error) => {
            if (err instanceof MediaExpiredError) {
              expired++;
              await save(key, EXPIRED_AUDIO_TEXT);
            } else {
              failed++;
              log(`Audio ${key}: no se pudo descargar (${err.message.slice(0, 120)})`);
            }
            return null;
          },
        ),
      );
    }
    return downloads.get(key)!;
  };

  const forLive: ChatwootAttachment[] = [];
  let primaryStop: string | null = null; // por qué se dejó de usar el modelo principal
  let consecutiveFailures = 0;

  const batches = transcribeStrategy === "live" ? [] : makeBatches(todo);
  if (transcribeStrategy === "live") {
    forLive.push(...todo);
    log(`Notas de voz: ${texts.size} ya resueltas, ${todo.length} nuevas.`);
  } else {
    log(
      `Notas de voz: ${texts.size} ya resueltas, ${todo.length} nuevas → ${batches.length} lote(s) a ${transcribeModel}, ` +
        `${transcribeConcurrency} en paralelo` + (transcribeLiveModel ? ` (respaldo: ${transcribeLiveModel}).` : "."),
    );
  }

  await runPool(batches, transcribeConcurrency, async (batch, i) => {
    const label = `Lote ${i + 1}/${batches.length}`;
    if (primaryStop) {
      forLive.push(...batch);
      return;
    }
    const items: AudioItem[] = [];
    const sent: ChatwootAttachment[] = [];
    for (const audio of batch) {
      const item = await fetchAudio(audio);
      if (item) {
        items.push(item);
        sent.push(audio);
      }
    }
    if (items.length === 0) return;

    try {
      log(`${label}: enviando ${items.length} nota(s) de voz...`);
      const result = await transcribeBatch(items, log);
      const missing: ChatwootAttachment[] = [];
      for (const [i, audio] of sent.entries()) {
        const text = result.texts.get(i + 1);
        if (text) await save(audioKey(audio), text);
        else missing.push(audio);
      }
      forLive.push(...missing);
      log(`${label}: ${result.texts.size}/${items.length} transcritas` + (missing.length ? ` (${missing.length} al respaldo)` : ""));
      if (missing.length > 0) log(`  Diagnóstico: finishReason=${result.finishReason ?? "?"} · respuesta: ${result.rawSample || "(vacía)"}`);
      // Un lote sin ninguna transcripción es una falla aunque Gemini haya respondido 200.
      if (result.texts.size > 0) consecutiveFailures = 0;
      else if (++consecutiveFailures >= 2) primaryStop ??= "devolvió 2 lotes seguidos sin transcripciones";
    } catch (err) {
      forLive.push(...sent);
      log(`${label} falló: ${(err as Error).message.slice(0, 200)}`);
      if (err instanceof QuotaError) primaryStop ??= err.message;
      else if (isRejection(err)) primaryStop ??= `rechazó el pedido (${(err as { status?: number }).status})`;
      else if (++consecutiveFailures >= 2) primaryStop ??= "falló en 2 lotes seguidos";
    }
  });
  if (primaryStop) log(`${transcribeModel} en pausa por esta corrida: ${primaryStop}.`);
  if (forLive.length === 0) return { texts, failed, pending: 0, expired };

  if (!transcribeLiveModel) {
    log(`${forLive.length} nota(s) de voz quedan pendientes (no hay modelo de respaldo configurado).`);
    return { texts, failed, pending: forLive.length, expired, quotaMessage: primaryStop ?? undefined };
  }

  log(`${transcribeStrategy === "live" ? "Transcribiendo con" : "Respaldo"} ${transcribeLiveModel}: ${forLive.length} nota(s) de voz, ${liveConcurrency} sesiones en paralelo...`);
  let liveOk = 0;
  let liveFailed = 0;
  let done = 0;
  let liveAborted = false;
  // Ritmo de sesiones nuevas (GEMINI_LIVE_RPM) y pausa compartida cuando Google corta por cuota.
  let livePauseUntil = 0;
  let nextLiveStart = 0;
  const liveSlot = async () => {
    for (;;) {
      const now = Date.now();
      const start = Math.max(now, livePauseUntil, nextLiveStart);
      if (start <= now) {
        nextLiveStart = now + 60_000 / geminiConfig().liveRpm;
        return;
      }
      await new Promise((r) => setTimeout(r, start - now));
    }
  };
  await runPool(forLive, liveConcurrency, async (audio) => {
    if (liveAborted) return;
    const item = await fetchAudio(audio);
    if (!item) {
      // Problema del archivo, no del modelo: no cuenta para cortar el respaldo (ya quedó contado).
      if (++done % 10 === 0 || done === forLive.length) log(`Respaldo: ${done}/${forLive.length} (${liveOk} transcritas)`);
      return;
    }
    for (let attempt = 1; ; attempt++) {
      await liveSlot();
      try {
        await recordUse(transcribeLiveModel);
        await save(audioKey(audio), await transcribeLive(item.data));
        liveOk++;
        break;
      } catch (err) {
        if (err instanceof LiveQuotaError && attempt < LIVE_QUOTA_ATTEMPTS) {
          // Cuota por minuto: todas las sesiones esperan juntas y este audio se reintenta.
          if (Date.now() >= livePauseUntil) log(`Cuota por minuto de ${transcribeLiveModel}: pausa de 60 s y reintento.`);
          livePauseUntil = Math.max(livePauseUntil, Date.now() + 60_000);
          continue;
        }
        liveFailed++;
        if (liveFailed <= 3) log(`Respaldo, audio ${audioKey(audio)}: ${(err as Error).message.slice(0, 200)}`);
        // Si las primeras sesiones fallan todas (y no por cuota), es un problema de configuración.
        if (liveOk === 0 && liveFailed >= 3 && !(err instanceof LiveQuotaError)) liveAborted = true;
        break;
      }
    }
    if (++done % 10 === 0 || done === forLive.length) log(`Respaldo: ${done}/${forLive.length} (${liveOk} transcritas)`);
  });

  failed += liveFailed;
  const pending = forLive.length - done;
  if (liveAborted) {
    const message = `El respaldo ${transcribeLiveModel} falló en sus primeros ${liveFailed} intentos; se detuvo.`;
    log(`${message} Quedan ${pending} nota(s) de voz pendientes.`);
    return { texts, failed, pending, expired, quotaMessage: message };
  }
  return { texts, failed, pending, expired, quotaMessage: primaryStop ?? undefined };
}

function attachmentText(attachment: ChatwootAttachment, transcriptions: Map<string, string>): string {
  switch (attachment.file_type) {
    case "audio":
      if (!attachment.data_url && !attachment.local_path) return "(nota de voz) [audio no disponible en Chatwoot]";
      return `(nota de voz) ${transcriptions.get(audioKey(attachment)) ?? "[sin transcribir]"}`;
    case "image":
      return "[imagen]";
    case "video":
      return "[video]";
    case "file":
      return attachment.extension ? `[archivo .${attachment.extension.replace(/^\./, "")}]` : "[archivo]";
    case "location": {
      const where = [attachment.fallback_title, attachment.coordinates_lat, attachment.coordinates_long].filter(Boolean);
      return `[ubicación${where.length ? `: ${where.join(", ")}` : ""}]`;
    }
    case "contact":
      return `[contacto compartido${attachment.fallback_title ? `: ${attachment.fallback_title}` : ""}]`;
    default:
      return `[adjunto: ${attachment.file_type}]`;
  }
}

function messageText(message: ChatwootMessage, transcriptions: Map<string, string>): string | null {
  if (message.content_attributes?.deleted) return "[mensaje eliminado]";
  const parts = (message.attachments ?? []).map((a) => attachmentText(a, transcriptions));
  const content = message.content?.trim();
  if (content) parts.push(content); // el caption de un adjunto va después del adjunto
  return parts.length > 0 ? parts.join(" ") : null;
}

export interface HistoryMeta {
  contactId: number;
  name: string | null;
  phone: string | null;
  conversations: number;
  messages: number;
  audios: number;
  failedAudios: number;
  pendingAudios: number; // sin transcribir por falta de presupuesto de Gemini
  expiredAudios: number; // WhatsApp ya no tiene el archivo
  quotaMessage: string | null;
  /** Mensajes que están en WhatsApp (Evolution) pero no llegaron a Chatwoot, agregados al historial. */
  recoveredFromWhatsApp: number;
  /** Exportación del teléfono: mensajes agregados, notas de voz recuperadas y desfase horario detectado. */
  fromExport: { added: number; filledAudios: number; matched: number; offsetHours: number | null } | null;
  /** "disabled" si Evolution no está configurado; el mensaje de error si no se pudo consultar. */
  evolutionStatus: "ok" | "disabled" | string;
  /** Sin conversaciones en Chatwoot: el historial se armó solo con WhatsApp (contacto creado para importar). */
  importOnly?: boolean;
  generatedAt: number; // epoch ms
  metrics: string[];
}

export interface BuildResult extends HistoryMeta {
  path: string;
}

export type Logger = (line: string) => void;

/** Completa el historial de Chatwoot con lo que Evolution tiene y Chatwoot perdió. */
async function mergeEvolution(
  contact: ChatwootContact,
  chatwoot: ChatwootMessage[],
  conversations: ChatwootConversation[],
  log: Logger,
): Promise<{ extra: ChatwootMessage[]; status: HistoryMeta["evolutionStatus"] }> {
  if (!evolutionConfig()) return { extra: [], status: "disabled" };
  try {
    log("Comparando con WhatsApp (Evolution)...");
    const evolution = await findContactMessages({ phone: contact.phone_number, identifier: contact.identifier });
    const extra = missingFromChatwoot(evolution, chatwoot, conversations, contact.name ?? null);
    log(`WhatsApp: ${evolution.length} registros; ${extra.length} mensaje(s) que no estaban en Chatwoot se agregan.`);
    return { extra, status: "ok" };
  } catch (err) {
    const message = (err as Error).message.slice(0, 200);
    log(`No se pudo consultar Evolution (${message}); el historial queda solo con Chatwoot.`);
    return { extra: [], status: message };
  }
}

/** Horas de diferencia de la zona con UTC (America/Bogota → -5). */
function zoneOffsetHours(timeZone: string, date = new Date()): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - date.getTime()) / 3_600_000);
}

/** Si hay una exportación del chat para este contacto, completa con ella lo que falte. */
async function mergeExportFile(contactId: number, history: ChatwootMessage[], conversations: ChatwootConversation[], log: Logger) {
  const data = await loadExport(contactId);
  if (!data) return null;
  // Notas de voz que conviene tomar del archivo exportado: sin archivo en Chatwoot, recuperadas vía
  // Evolution (WhatsApp deja de servirlas a las pocas semanas) o ya marcadas como vencidas. Así se
  // pueden transcribir y también reproducir desde la interfaz.
  const unusable = new Set<string>();
  for (const a of history.flatMap((m) => m.attachments ?? []).filter((a) => a.file_type === "audio")) {
    const cached = await readFile(cachePath(audioKey(a)), "utf-8").catch(() => null);
    if (!a.data_url || a.data_url.startsWith(EVOLUTION_URL_PREFIX) || cached === EXPIRED_AUDIO_TEXT) unusable.add(audioKey(a));
  }
  const result = await mergeExport(data, history, (a) => unusable.has(audioKey(a)), zoneOffsetHours(TIMEZONE));
  if (result.offsetHours === null) {
    log(
      `Exportación del teléfono: ${data.messages.length} mensajes, pero no se pudo alinear con el historial (se ignora). ` +
        "Si el cliente no está en Chatwoot, indique quién es el cliente al importar.",
    );
    return null;
  }
  for (const m of result.added) m.conversation_id = conversationAt(conversations, m.created_at);
  const utc = `UTC${result.offsetHours >= 0 ? "+" : ""}${result.offsetHours}`;
  log(
    result.standalone
      ? `Exportación del teléfono (${utc}, cliente: ${data.clientSender}): ${data.messages.length} mensajes, ${result.matched} ya estaban; se agregan ${result.added.length}.`
      : `Exportación del teléfono (${utc}): ${data.messages.length} mensajes, ${result.matched} ya estaban; ` +
          `se agregan ${result.added.length} y aportan el archivo de ${result.filled} nota(s) de voz.`,
  );
  return result;
}

/**
 * Descarga todo el historial del contacto (Chatwoot + lo que falte de WhatsApp vía Evolution) y lo
 * escribe como transcript en data/contact-<id>.txt, con un resumen en data/contact-<id>.meta.json.
 */
export async function buildHistory(contactId: number, log: Logger = console.log): Promise<BuildResult> {
  const contact = await getContact(contactId);
  log(`Buscando conversaciones de ${contact.name ?? "sin nombre"}...`);
  const conversations = await getContactConversations(contactId, log);
  log(`${conversations.length} conversación(es). Descargando mensajes...`);

  const chatwootMessages: ChatwootMessage[] = [];
  for (const conversation of conversations) {
    const batch = await getAllMessages(conversation.id);
    chatwootMessages.push(...batch.map((m) => ({ ...m, conversation_id: conversation.id })));
  }
  const { extra, status } = await mergeEvolution(contact, chatwootMessages, conversations, log);
  const exported = await mergeExportFile(contactId, [...chatwootMessages, ...extra], conversations, log);
  // Contacto creado para importar su chat (sin conversaciones en Chatwoot): todo viene de WhatsApp, así
  // que no tiene sentido marcar cada mensaje como "no llegó a Chatwoot".
  const importOnly = conversations.length === 0 && extra.length + (exported?.added.length ?? 0) > 0;
  if (importOnly) for (const m of [...extra, ...(exported?.added ?? [])]) delete m.origin;

  const messages = [...chatwootMessages, ...extra, ...(exported?.added ?? [])]
    .filter((m) => m.message_type !== MESSAGE_TYPE.activity)
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  log(`${messages.length} mensajes en total.`);

  const audios = messages.flatMap((m) => (m.attachments ?? []).filter((a) => a.file_type === "audio"));
  const { texts, failed, pending, expired, quotaMessage } = await transcribeAll(audios, log);

  const lines: string[] = [];
  const structured: ChatMessage[] = [];
  for (const message of messages) {
    const text = messageText(message, texts);
    if (!text) continue;
    lines.push(`[${formatDate(message.created_at)}] ${senderLabel(message)}: ${text}`);
    structured.push(toChatMessage(message, text, contact.name ?? null));
  }

  const metrics = computeMetrics(messages, formatDate);
  const meta: HistoryMeta = {
    contactId,
    name: contact.name ?? null,
    phone: contact.phone_number ?? null,
    conversations: conversations.length,
    messages: lines.length,
    audios: audios.length,
    failedAudios: failed,
    pendingAudios: pending,
    expiredAudios: expired,
    quotaMessage: quotaMessage ?? null,
    recoveredFromWhatsApp: extra.length + (exported?.added.length ?? 0),
    fromExport: exported
      ? { added: exported.added.length, filledAudios: exported.filled, matched: exported.matched, offsetHours: exported.offsetHours }
      : null,
    evolutionStatus: status,
    importOnly,
    generatedAt: Date.now(),
    metrics,
  };

  const header = [
    `Contacto: ${meta.name ?? "sin nombre"} (contact_id ${contactId})` + (meta.phone ? ` · Tel: ${meta.phone}` : ""),
    `Conversaciones: ${meta.conversations} · Mensajes: ${meta.messages} · Zona horaria: ${TIMEZONE}`,
    `Generado: ${formatDate(meta.generatedAt / 1000)}`,
    ...(importOnly
      ? [
          "Origen: este cliente no tiene conversaciones en Chatwoot; el historial viene de WhatsApp (la exportación del chat " +
            "desde el teléfono y lo que registró el WhatsApp del negocio).",
        ]
      : meta.recoveredFromWhatsApp > 0
      ? [
          `Mensajes recuperados de WhatsApp: ${meta.recoveredFromWhatsApp}. Están en WhatsApp pero NUNCA llegaron a Chatwoot (falla de ` +
            "sincronización), así que el equipo pudo no haberlos visto en Chatwoot. Van marcados [solo en WhatsApp].",
        ]
      : []),
    "",
    ...metrics,
    "",
    "--- MENSAJES ---",
  ];

  const path = historyPath(contactId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [...header, ...lines].join("\n") + "\n", "utf-8");
  await writeFile(historyMetaPath(contactId), JSON.stringify(meta, null, 2), "utf-8");
  await writeFile(historyMessagesPath(contactId), JSON.stringify(structured), "utf-8");
  return { ...meta, path };
}

export async function readHistoryMeta(contactId: number): Promise<HistoryMeta | null> {
  const raw = await readFile(historyMetaPath(contactId), "utf-8").catch(() => null);
  return raw ? (JSON.parse(raw) as HistoryMeta) : null;
}

// ---------------------------------------------------------------------------
// Mensajes estructurados para la vista de chat de la interfaz (el transcript de texto es para Gemini).
// ---------------------------------------------------------------------------

/** Dónde está el archivo de una nota de voz, para poder reproducirla desde la interfaz. */
export type AudioSource = { type: "chatwoot"; url: string } | { type: "evolution"; id: string } | { type: "file"; path: string };

export interface ChatMessage {
  at: number; // epoch en segundos
  role: "client" | "agent" | "bot" | "internal";
  name: string | null;
  text: string;
  kind: string; // "text" o el tipo del adjunto principal: audio, image, video, file...
  onlyWhatsApp?: boolean; // está en WhatsApp pero nunca llegó a Chatwoot
  audio?: { key: string; source: AudioSource };
}

function toChatMessage(message: ChatwootMessage, text: string, contactName: string | null): ChatMessage {
  const role: ChatMessage["role"] =
    message.message_type === MESSAGE_TYPE.incoming
      ? "client"
      : message.private
        ? "internal"
        : message.sender?.type === "agent_bot"
          ? "bot"
          : "agent";
  const audio = message.attachments?.find((a) => a.file_type === "audio" && (a.data_url || a.local_path));
  let source: AudioSource | undefined;
  if (audio?.local_path) source = { type: "file", path: relative(DATA_DIR, audio.local_path) };
  else if (audio?.data_url.startsWith(EVOLUTION_URL_PREFIX)) source = { type: "evolution", id: audio.data_url.slice(EVOLUTION_URL_PREFIX.length) };
  else if (audio?.data_url) source = { type: "chatwoot", url: audio.data_url };
  return {
    at: message.created_at,
    role,
    name: message.sender?.name?.trim() || (role === "client" ? contactName : null),
    text,
    kind: message.attachments?.[0]?.file_type ?? "text",
    ...(message.origin === "whatsapp" ? { onlyWhatsApp: true } : {}),
    ...(audio && source ? { audio: { key: audioKey(audio), source } } : {}),
  };
}

export async function readHistoryMessages(contactId: number): Promise<ChatMessage[] | null> {
  const raw = await readFile(historyMessagesPath(contactId), "utf-8").catch(() => null);
  return raw ? (JSON.parse(raw) as ChatMessage[]) : null;
}

/** Bytes de una nota de voz del historial, desde donde esté (Chatwoot, Evolution o la exportación). */
export async function readAudio(source: AudioSource): Promise<{ data: Buffer; contentType: string }> {
  if (source.type === "file") {
    const full = resolve(DATA_DIR, source.path);
    if (!full.startsWith(DATA_DIR)) throw new Error("Ruta de audio inválida");
    return { data: await readFile(full), contentType: "audio/ogg" };
  }
  const { data, contentType } =
    source.type === "evolution" ? await downloadEvolutionMedia(source.id) : await downloadAttachment(source.url);
  return { data, contentType: contentType?.startsWith("audio/") ? contentType : "audio/ogg" };
}
