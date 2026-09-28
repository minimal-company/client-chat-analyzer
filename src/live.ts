import { spawn } from "node:child_process";
import { Modality, type GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import { geminiConfig } from "./config.js";
import { geminiClient } from "./providers.js";

// Transcripción por la Live API (WebSocket). Es el camino de respaldo: sin límite diario de
// requests, pero una sesión por nota de voz y audio en PCM crudo, así que no se puede agrupar.

const SAMPLE_RATE = 16_000; // la Live API espera PCM de 16 bits, mono, 16 kHz, little-endian
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

function ai(): GoogleGenAI {
  const { apiKey, baseUrl } = geminiConfig();
  return geminiClient(apiKey, baseUrl);
}

/** Convierte cualquier formato de audio (ogg/opus de WhatsApp, mp3, m4a...) a PCM con ffmpeg. */
export function decodeToPcm(audio: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"]);
    const out: Buffer[] = [];
    let stderr = "";
    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    ffmpeg.on("error", (err) => reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`)));
    ffmpeg.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg terminó con código ${code}: ${stderr.slice(-200)}`)),
    );
    ffmpeg.stdin.on("error", () => {}); // si ffmpeg corta antes, el error real sale por "close"
    ffmpeg.stdin.end(audio);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Google cerró la sesión por cuota (por minuto): conviene esperar y reintentar, no abandonar. */
export class LiveQuotaError extends Error {}

/**
 * Transcribe una nota de voz en una sesión Live. El audio se marca como un único turno
 * (activityStart/activityEnd manuales, sin detección automática de voz) y se junta el texto que
 * devuelve el modelo; si no devuelve texto propio, se usa la transcripción de entrada.
 */
export async function transcribeLive(audio: Buffer): Promise<string> {
  const { transcribeLiveModel: model, liveSpeed } = geminiConfig();
  const pcm = await decodeToPcm(audio);
  const seconds = pcm.length / BYTES_PER_SECOND;

  return new Promise<string>((resolve, reject) => {
    let session: Session | undefined;
    let modelText = "";
    let inputText = "";
    let settled = false;
    let markReady: () => void = () => {};
    const ready = new Promise<void>((r) => (markReady = r));

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        session?.close();
      } catch {
        // ya cerrada
      }
      const text = (modelText || inputText).trim();
      if (err && !text) reject(err);
      else resolve(text || "[audio no transcribible]");
    };
    // Tiempo de envío + margen para que el modelo termine de responder.
    const timeout = setTimeout(() => finish(new Error("La sesión Live no respondió a tiempo")), (seconds / liveSpeed) * 1000 + 60_000);

    // Los modelos de transcripción mandan la transcripción final junto con generationComplete y
    // nunca turnComplete: si se espera turnComplete, la sesión queda abierta ~60 s hasta que Google
    // la cierra. Se termina con lo que llegue primero.
    let audioSent = false;
    const onmessage = (m: LiveServerMessage) => {
      if (m.setupComplete) markReady();
      const content = m.serverContent;
      if (content?.inputTranscription?.text) inputText += content.inputTranscription.text;
      for (const part of content?.modelTurn?.parts ?? []) if (part.text && !part.thought) modelText += part.text;
      if (content?.turnComplete || content?.generationComplete) finish();
      // Respaldo por si generationComplete no llega: la transcripción final después de activityEnd.
      else if (audioSent && content?.inputTranscription?.text) setTimeout(() => finish(), 2000);
    };

    ai()
      .live.connect({
        model,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {},
          systemInstruction:
            "Transcribe literalmente el audio que recibas, en el idioma en que fue hablado. " +
            "Responde solo con la transcripción, sin comentarios.",
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
        callbacks: {
          onmessage,
          onerror: (e) => finish(new Error(`Error de la sesión Live: ${e.message ?? "WebSocket"}`)),
          onclose: (e) => {
            const message = `La sesión Live se cerró (código ${e.code}${e.reason ? `: ${e.reason}` : ""})`;
            finish(/quota/i.test(e.reason ?? "") ? new LiveQuotaError(message) : new Error(message));
          },
        },
      })
      .then(async (s) => {
        session = s;
        await Promise.race([ready, sleep(15_000)]);
        if (settled) return;
        s.sendRealtimeInput({ activityStart: {} });
        // Trozos de 1 s, enviados a `liveSpeed` veces la velocidad real.
        for (let offset = 0; offset < pcm.length && !settled; offset += BYTES_PER_SECOND) {
          const chunk = pcm.subarray(offset, offset + BYTES_PER_SECOND);
          s.sendRealtimeInput({ audio: { data: chunk.toString("base64"), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` } });
          await sleep(1000 / liveSpeed);
        }
        if (!settled) {
          s.sendRealtimeInput({ activityEnd: {} });
          audioSent = true;
        }
      })
      .catch((err: Error) => finish(err));
  });
}
