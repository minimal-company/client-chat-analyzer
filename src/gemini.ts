import { createPartFromUri, FileState, type GoogleGenAI, type Part } from "@google/genai";
import { geminiConfig } from "./config.js";
import { geminiClient } from "./providers.js";
import { acquire, isDailyQuotaError, markExhausted, nextResetLabel, QuotaError, type Purpose } from "./quota.js";
import { withRetry } from "./retry.js";

// Transcripción de notas de voz por lotes con Gemini. (Las preguntas sobre el historial están en llm.ts.)

/** El request inline tiene tope de 20 MB y base64 infla ~33%: por encima de esto se usa la Files API. */
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

/** Pocos reintentos: cada uno es un request más contra la cuota diaria. */
const GEMINI_ATTEMPTS = 3;

function ai(): GoogleGenAI {
  const { apiKey, baseUrl } = geminiConfig();
  return geminiClient(apiKey, baseUrl);
}

/**
 * Toda llamada a generateContent pasa por acá: reserva presupuesto antes de cada intento y, si
 * Google responde "cuota diaria agotada", marca el modelo para no volver a llamarlo hasta el reset.
 */
async function geminiCall<T>(
  model: string,
  purpose: Purpose,
  label: string,
  fn: () => Promise<T>,
  log?: (line: string) => void,
  attempts = GEMINI_ATTEMPTS,
): Promise<T> {
  return withRetry(
    label,
    async () => {
      await acquire(model, purpose);
      try {
        return await fn();
      } catch (err) {
        if (!isDailyQuotaError(err)) throw err;
        await markExhausted(model);
        throw new QuotaError(`Google informó que la cuota diaria de ${model} está agotada. Se renueva a las ${nextResetLabel()}.`);
      }
    },
    attempts,
    log,
  );
}

async function audioPart(audio: Buffer, mimeType: string): Promise<{ part: Part; cleanup?: () => Promise<unknown> }> {
  if (audio.length <= MAX_INLINE_BYTES) {
    return { part: { inlineData: { mimeType, data: audio.toString("base64") } } };
  }

  let file = await withRetry("Gemini upload", () =>
    ai().files.upload({ file: new Blob([audio], { type: mimeType }), config: { mimeType } }),
  );
  for (let i = 0; file.state === FileState.PROCESSING && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai().files.get({ name: file.name! });
  }
  if (file.state !== FileState.ACTIVE) throw new Error(`Gemini no pudo procesar el audio (estado ${file.state})`);

  return {
    part: createPartFromUri(file.uri!, file.mimeType ?? mimeType),
    cleanup: () => ai().files.delete({ name: file.name! }).catch(() => {}), // igual expira a las 48 h
  };
}

export interface AudioItem {
  data: Buffer;
  mimeType: string;
}

/**
 * Lee la respuesta del lote. El formato pedido es texto plano con marcadores ([[AUDIO 1]] seguido de
 * la transcripción), que cualquier modelo puede producir, incluidos los de solo transcripción que no
 * soportan modo JSON. Si el modelo igual devuelve JSON, también se acepta. Una respuesta cortada
 * conserva los audios completos; los que falten van al respaldo o a la próxima actualización.
 */
function parseBatch(raw: string): Map<number, string> {
  const markers = [...raw.matchAll(/\[\[\s*AUDIO\s+(\d+)\s*\]\]/gi)];
  if (markers.length > 0) {
    const result = new Map<number, string>();
    markers.forEach((m, i) => {
      const text = raw.slice(m.index! + m[0].length, markers[i + 1]?.index ?? raw.length).trim();
      // El último bloque de una respuesta cortada puede quedar a medias: igual es mejor que nada.
      result.set(Number(m[1]), text || "[sin transcripción]");
    });
    return result;
  }
  return parseBatchJson(raw);
}

function parseBatchJson(raw: string): Map<number, string> {
  const result = new Map<number, string>();
  // El modelo a veces envuelve el JSON en ```json ... ``` aunque se pida JSON puro.
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Respuesta cortada: rescatar los objetos completos. El id puede venir como "20", 20 o "AUDIO 20".
    parsed = [...body.matchAll(/\{\s*"id"\s*:\s*("[^"]*"|\d+)\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g)].map((m) => ({
      id: JSON.parse(m[1]),
      text: JSON.parse(m[2]),
    }));
  }
  // Tolera un objeto envoltorio ({"transcripciones": [...]}) en vez del array pedido.
  const entries = Array.isArray(parsed)
    ? parsed
    : (Object.values((parsed as object) ?? {}).find(Array.isArray) as unknown[] | undefined) ?? [];

  for (const e of entries as Record<string, unknown>[]) {
    const id = Number(String(e?.id ?? e?.audio_id ?? "").match(/\d+/)?.[0]);
    const text = e?.text ?? e?.transcription ?? e?.transcripcion ?? e?.transcript;
    if (Number.isInteger(id) && typeof text === "string") result.set(id, text.trim() || "[sin transcripción]");
  }
  return result;
}

export interface BatchResult {
  /** Texto por posición del audio en el lote (1..n). */
  texts: Map<number, string>;
  /** Para diagnosticar lotes incompletos: motivo de fin y comienzo de la respuesta cruda. */
  finishReason?: string;
  rawSample: string;
}

/**
 * Transcribe varias notas de voz en UN solo request (la cuota se cuenta por request, no por audio).
 * Cada audio va precedido de una etiqueta con su posición (AUDIO 1, AUDIO 2...) y la respuesta trae un
 * bloque [[AUDIO n]] por audio. Devuelve el texto por posición (1..n); el que falte pasa al respaldo.
 */
export async function transcribeBatch(items: AudioItem[], log?: (line: string) => void): Promise<BatchResult> {
  const prepared = await Promise.all(items.map((item) => audioPart(item.data, item.mimeType)));
  const parts: Part[] = [
    {
      text:
        `Vas a recibir ${items.length} notas de voz de WhatsApp. Cada una está precedida por una etiqueta ` +
        '"AUDIO <id>". Transcribe cada audio literalmente, en el idioma en que fue hablado, sin comentarios ' +
        "ni marcas de tiempo. No mezcles contenido entre audios: cada transcripción corresponde solo al audio " +
        "que sigue a su etiqueta. Responde con un bloque por audio, en el mismo orden y sin omitir ninguno: " +
        "una línea [[AUDIO <id>]] con el mismo número de la etiqueta, y debajo la transcripción. Por ejemplo:\n" +
        "[[AUDIO 1]]\nhola, ¿cómo estás?\n[[AUDIO 2]]\nte llamo más tarde\n" +
        'Si un audio no tiene voz inteligible, escribe "[audio no transcribible]" en su bloque.',
    },
  ];
  items.forEach((_, i) => parts.push({ text: `AUDIO ${i + 1}` }, prepared[i].part));

  try {
    const response = await geminiCall(
      geminiConfig().transcribeModel,
      "transcribe",
      "Gemini transcripción",
      () =>
        ai().models.generateContent({
          model: geminiConfig().transcribeModel,
          contents: [{ role: "user", parts }],
          config: { maxOutputTokens: 32768 },
        }),
      log,
    );
    const raw = response.text ?? "";
    const wanted = new Set(items.map((_, i) => i + 1));
    return {
      texts: new Map([...parseBatch(raw)].filter(([id]) => wanted.has(id))),
      finishReason: response.candidates?.[0]?.finishReason,
      rawSample: raw.slice(0, 300).replace(/\s+/g, " "),
    };
  } finally {
    await Promise.all(prepared.map((p) => p.cleanup?.()));
  }
}
