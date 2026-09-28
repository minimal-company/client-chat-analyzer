import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.js";
import type { ChatwootAttachment, ChatwootMessage } from "./types.js";

// Tercera fuente: la exportación del chat desde el teléfono (WhatsApp → Exportar chat → Incluir
// archivos). Es la única que conserva los archivos que WhatsApp ya no sirve. Se guarda descomprimida
// en data/exports/contact-<id>/ (_chat.txt + las notas de voz) y en cada actualización se cruza con el
// historial: solo se usa lo que falta.

export interface ExportMessage {
  /** Hora tal como la escribió el teléfono, leída como si fuera UTC (se corrige con `offsetHours`). */
  localAt: number;
  sender: string;
  text: string;
  file?: string;
}

export interface ExportData {
  dir: string;
  messages: ExportMessage[];
  /** Quién es el cliente en el chat, si lo indicó el usuario (contactos que no estaban en Chatwoot). */
  clientSender?: string;
}

export const exportDir = (contactId: number) => resolve(DATA_DIR, "exports", `contact-${contactId}`);
const metaPath = (contactId: number) => resolve(exportDir(contactId), "meta.json");

export async function readExportMeta(contactId: number): Promise<{ clientSender?: string }> {
  const raw = await readFile(metaPath(contactId), "utf-8").catch(() => null);
  return raw ? JSON.parse(raw) : {};
}

export async function writeExportMeta(contactId: number, meta: { clientSender?: string }) {
  await writeFile(metaPath(contactId), JSON.stringify(meta, null, 2), "utf-8");
}

/** Remitentes del chat con su cantidad de mensajes, el que más escribió primero. */
export function exportSenders(messages: ExportMessage[]): { name: string; messages: number }[] {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
  return [...counts].map(([name, n]) => ({ name, messages: n })).sort((a, b) => b.messages - a.messages);
}

/**
 * El remitente que más probablemente es el cliente: el que se parece al nombre o al teléfono del
 * contacto. Si ninguno se parece, null (lo decide el usuario).
 */
export function guessClientSender(senders: { name: string }[], contact: { name?: string | null; phone?: string | null }): string | null {
  const digits = (s: string) => s.replace(/\D/g, "");
  const phone = digits(contact.phone ?? "");
  const byPhone = phone.length >= 7 ? senders.find((s) => digits(s.name).length >= 7 && phone.endsWith(digits(s.name).slice(-7))) : undefined;
  if (byPhone) return byPhone.name;
  const words = new Set(normalize(contact.name).split(" ").filter((w) => w.length > 2));
  const byName = senders
    .map((s) => ({ s, common: normalize(s.name).split(" ").filter((w) => words.has(w)).length }))
    .filter((x) => x.common > 0)
    .sort((a, b) => b.common - a.common)[0];
  return byName?.s.name ?? null;
}

const HEADER = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]\s([^:]+):\s?(.*)$/;
const DELETED = /^(This message was deleted|You deleted this message|Se eliminó este mensaje|Eliminaste este mensaje).?$/i;
const SYSTEM = /end-to-end encrypted|cifrados de extremo a extremo|is a contact\.?$|es un contacto\.?$/i;

/** Lee _chat.txt. Soporta día/mes o mes/día (se deduce del archivo) y reloj de 12 o 24 horas. */
export function parseExport(raw: string): ExportMessage[] {
  const lines = raw.replace(/[‎‏\r]/g, "").replace(/[  ]/g, " ").split("\n");
  const headers = lines.map((l) => HEADER.exec(l));
  // Si algún primer número pasa de 12, el formato es día/mes; si pasa el segundo, mes/día.
  const dayFirst = headers.some((h) => h && +h[1] > 12) || !headers.some((h) => h && +h[2] > 12);

  const messages: ExportMessage[] = [];
  for (const [i, h] of headers.entries()) {
    if (!h) {
      if (messages.length && lines[i].trim()) messages[messages.length - 1].text += `\n${lines[i]}`; // mensaje de varias líneas
      continue;
    }
    const [, a, b, y, hh, mm, ss, ampm, sender, rest] = h;
    const [day, month] = dayFirst ? [+a, +b] : [+b, +a];
    let hour = +hh % 12;
    if (!ampm) hour = +hh;
    else if (/p/i.test(ampm)) hour += 12;
    const year = y.length === 2 ? 2000 + +y : +y;
    const localAt = Date.UTC(year, month - 1, day, hour, +mm, +(ss ?? 0)) / 1000;

    const file = /<(?:attached|adjunto):\s*([^>]+)>/i.exec(rest)?.[1]?.trim();
    const text = rest.replace(/<(?:attached|adjunto):[^>]+>/i, "").replace(/<(This message was edited|Se editó este mensaje\.?)>/i, "").trim();
    if (!file && SYSTEM.test(text)) continue;
    messages.push({ localAt, sender: sender.trim(), text, file });
  }
  return messages;
}

export async function loadExport(contactId: number): Promise<ExportData | null> {
  const dir = exportDir(contactId);
  const raw = await readFile(resolve(dir, "_chat.txt"), "utf-8").catch(() => null);
  if (!raw) return null;
  const { clientSender } = await readExportMeta(contactId);
  return { dir, messages: parseExport(raw), ...(clientSender ? { clientSender } : {}) };
}

type Kind = "audio" | "text" | "media";

function kindOfFile(file: string): { kind: Kind; fileType: string } {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (["opus", "ogg", "oga", "m4a", "mp3", "aac", "wav", "amr"].includes(ext)) return { kind: "audio", fileType: "audio" };
  if (/STICKER/i.test(file) || ext === "webp") return { kind: "media", fileType: "sticker" };
  if (["jpg", "jpeg", "png", "gif", "heic"].includes(ext)) return { kind: "media", fileType: "image" };
  if (["mp4", "mov", "3gp", "mkv", "avi"].includes(ext)) return { kind: "media", fileType: "video" };
  if (ext === "vcf") return { kind: "media", fileType: "contact" };
  return { kind: "media", fileType: "file" };
}

function kindOfMessage(m: ChatwootMessage): Kind {
  const a = m.attachments?.[0];
  if (!a) return "text";
  return a.file_type === "audio" ? "audio" : "media";
}

const normalize = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Parecido de dos textos: iguales, uno contiene al otro (firma del agente, etc.) o ≥50 % de palabras en común. */
function similar(a: string, b: string): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  if (!x || !y) return x === y;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const wx = new Set(x.split(" "));
  const wy = new Set(y.split(" "));
  const common = [...wx].filter((w) => wy.has(w)).length;
  return common / Math.max(wx.size, wy.size) >= 0.5;
}

export interface ExportMerge {
  /** Mensajes de la exportación que no están en el historial: se agregan. */
  added: ChatwootMessage[];
  /** Notas de voz del historial sin audio utilizable (vencidas en WhatsApp) que ahora tienen archivo local. */
  filled: number;
  matched: number;
  offsetHours: number | null;
  /** No hubo con qué alinear (contacto nuevo): se usó la zona horaria configurada y el cliente elegido. */
  standalone: boolean;
}

/**
 * Cruza la exportación con el historial (Chatwoot + Evolution ya fusionados).
 *
 * 1. Zona horaria del teléfono y quién es el cliente: se deducen de los archivos (notas de voz, fotos,
 *    videos), que tienen el mismo tamaño exacto en bytes en la exportación y en el historial.
 * 2. Emparejado: archivos por tamaño exacto (±30 min); lo demás por tipo, dirección, ±3 min y, en
 *    texto, parecido del contenido.
 * 3. Lo que queda sin pareja se agrega; las notas de voz del historial sin audio reciben el archivo local.
 */
export async function mergeExport(
  data: ExportData,
  history: ChatwootMessage[],
  isUnusableAudio: (a: ChatwootAttachment) => boolean,
  /** Desfase de la zona horaria configurada: se usa si no hay con qué alinear y el usuario eligió al cliente. */
  fallbackOffsetHours?: number,
): Promise<ExportMerge> {
  const sizes = new Map<string, number>();
  await Promise.all(
    data.messages
      .filter((m) => m.file)
      .map(async (m) => {
        const size = await stat(resolve(data.dir, m.file!)).then((s) => s.size).catch(() => 0);
        if (size) sizes.set(m.file!, size);
      }),
  );

  const candidates = history.filter((m) => !m.private && m.message_type !== 2);
  // Los archivos (notas de voz, fotos, videos) conservan su tamaño exacto en bytes de punta a punta.
  const historyFiles = candidates.filter((m) => m.attachments?.some((a) => a.file_size));
  const hasSize = (h: ChatwootMessage, size: number | undefined) => !!size && !!h.attachments?.some((a) => a.file_size === size);

  // 1. Desfase horario: el que más archivos empareja por tamaño exacto.
  const exportFiles = data.messages.filter((m) => m.file && sizes.has(m.file));
  let offsetHours: number | null = null;
  let best = 0;
  for (let off = -12; off <= 14; off++) {
    const hits = exportFiles.filter((e) =>
      historyFiles.some((h) => hasSize(h, sizes.get(e.file!)) && Math.abs(h.created_at - (e.localAt - off * 3600)) <= 600),
    ).length;
    if (hits > best) [best, offsetHours] = [hits, off];
  }
  // Sin al menos 3 archivos en común no hay alineación confiable. Si el usuario dijo quién es el cliente
  // (contacto que no estaba en Chatwoot), se toma la hora del teléfono como la de la zona configurada.
  let standalone = false;
  if (offsetHours === null || best < 3) {
    if (!data.clientSender || fallbackOffsetHours === undefined) return { added: [], filled: 0, matched: 0, offsetHours: null, standalone: false };
    offsetHours = fallbackOffsetHours;
    standalone = true;
  }
  const at = (e: ExportMessage) => e.localAt - offsetHours! * 3600;

  // Quién es el cliente: el que eligió el usuario o, si no, el remitente cuyos archivos coinciden con
  // mensajes entrantes.
  const incomingVotes = new Map<string, number>();
  for (const e of exportFiles) {
    const h = historyFiles.find((x) => hasSize(x, sizes.get(e.file!)) && Math.abs(x.created_at - at(e)) <= 1800);
    if (h) incomingVotes.set(e.sender, (incomingVotes.get(e.sender) ?? 0) + (h.message_type === 0 ? 1 : -1));
  }
  const isIncoming = (e: ExportMessage) => (data.clientSender ? e.sender === data.clientSender : (incomingVotes.get(e.sender) ?? 0) > 0);

  // 2. Emparejado. Cada mensaje del historial admite tantos de la exportación como adjuntos tenga:
  // Chatwoot agrupa un álbum de fotos en un solo mensaje, y la exportación lista cada foto aparte.
  const uses = new Map<ChatwootMessage, number>();
  const capacity = (h: ChatwootMessage) => Math.max(1, h.attachments?.length ?? 0);
  const pairOf = new Map<ExportMessage, ChatwootMessage>();
  const take = (e: ExportMessage, h: ChatwootMessage | undefined) => {
    if (!h) return;
    uses.set(h, (uses.get(h) ?? 0) + 1);
    pairOf.set(e, h);
  };
  const closest = (e: ExportMessage, list: ChatwootMessage[]) =>
    list
      .filter((h) => (uses.get(h) ?? 0) < capacity(h))
      .sort((x, y) => Math.abs(x.created_at - at(e)) - Math.abs(y.created_at - at(e)))[0];

  for (const e of exportFiles) {
    take(e, closest(e, historyFiles.filter((h) => hasSize(h, sizes.get(e.file!)) && Math.abs(h.created_at - at(e)) <= 1800)));
  }
  for (const e of data.messages) {
    if (pairOf.has(e)) continue;
    const kind = e.file ? kindOfFile(e.file).kind : "text";
    const incoming = isIncoming(e);
    take(
      e,
      closest(
        e,
        candidates.filter(
          (h) =>
            (h.message_type === 0) === incoming &&
            kindOfMessage(h) === kind &&
            Math.abs(h.created_at - at(e)) <= 180 &&
            (kind !== "text" || similar(h.content ?? "", e.text)),
        ),
      ),
    );
  }

  // 3. Resultado.
  let filled = 0;
  const added: ChatwootMessage[] = [];
  for (const e of data.messages) {
    const h = pairOf.get(e);
    if (h) {
      const a = h.attachments?.[0];
      if (a?.file_type === "audio" && e.file && isUnusableAudio(a)) {
        a.local_path = resolve(data.dir, e.file);
        filled++;
      }
      continue;
    }
    const media = e.file ? kindOfFile(e.file) : null;
    const attachment = media
      ? ({ id: 0, file_type: media.fileType, data_url: "", local_path: resolve(data.dir, e.file!), file_size: sizes.get(e.file!) ?? null } as ChatwootAttachment)
      : null;
    added.push({
      id: 0,
      content: e.text || null,
      content_attributes: DELETED.test(e.text) ? { deleted: true } : null,
      message_type: isIncoming(e) ? 0 : 1,
      private: false,
      created_at: at(e),
      origin: "whatsapp",
      sender: isIncoming(e) ? { type: "contact", name: e.sender } : { type: "user", name: e.sender },
      attachments: attachment ? [attachment] : [],
    });
  }
  return { added, filled, matched: pairOf.size, offsetHours, standalone };
}
