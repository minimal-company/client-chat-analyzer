import { evolutionConfig } from "./config.js";
import { HttpError, withRetry } from "./retry.js";

// Evolution API como segunda fuente de verdad. Evolution recibe todo lo que llega a WhatsApp y lo
// guarda en su base, pero el puente a Chatwoot pierde mensajes (p. ej. el bug de contactos @lid en
// 2.3.x). Acá se leen los mensajes de un contacto directo de Evolution para completar el historial.

export interface EvolutionMessage {
  key: { id: string; fromMe: boolean; remoteJid: string; remoteJidAlt?: string };
  pushName?: string | null;
  messageType: string;
  message?: Record<string, any> | null;
  messageTimestamp: number; // epoch en segundos
}

/** WhatsApp ya no sirve el archivo (vence a las pocas semanas): no tiene sentido reintentar. */
export class MediaExpiredError extends Error {}

async function evoPost(path: string, body: unknown): Promise<any> {
  const config = evolutionConfig()!;
  const url = `${config.baseUrl}${path}/${encodeURIComponent(config.instance)}`;
  return withRetry(`Evolution ${path}`, async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: config.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`Evolution respondió ${res.status} en ${path}: ${text.slice(0, 300)}`, res.status);
    return JSON.parse(text);
  });
}

async function findMessages(key: Record<string, string>): Promise<EvolutionMessage[]> {
  const all: EvolutionMessage[] = [];
  for (let page = 1; ; page++) {
    const json = await evoPost("/chat/findMessages", { where: { key }, page, offset: 500 });
    const records: EvolutionMessage[] = json.messages?.records ?? [];
    all.push(...records);
    if (records.length === 0 || page >= (json.messages?.pages ?? 1)) return all;
  }
}

const phoneJid = (phone: string) => `${phone.replace(/\D/g, "")}@s.whatsapp.net`;

/**
 * Todos los mensajes de un contacto en Evolution. WhatsApp está migrando a identificadores @lid, así
 * que un mismo cliente puede tener mensajes bajo su número y bajo su @lid: se buscan ambos y se
 * descubren los @lid a partir de los mensajes que traen el número como remoteJidAlt.
 */
export async function findContactMessages(contact: { phone?: string | null; identifier?: string | null }): Promise<EvolutionMessage[]> {
  const jids = new Set<string>();
  if (contact.phone) jids.add(phoneJid(contact.phone));
  if (contact.identifier && /@(s\.whatsapp\.net|lid)$/.test(contact.identifier)) jids.add(contact.identifier);
  if (jids.size === 0) return [];

  const byId = new Map<string, EvolutionMessage>();
  const add = (list: EvolutionMessage[]) => list.forEach((m) => byId.set(m.key.id, m));

  for (const jid of [...jids].filter((j) => j.endsWith("@s.whatsapp.net"))) {
    add(await findMessages({ remoteJid: jid }));
    const viaAlt = await findMessages({ remoteJidAlt: jid });
    add(viaAlt);
    for (const m of viaAlt) if (m.key.remoteJid.endsWith("@lid")) jids.add(m.key.remoteJid);
  }
  for (const jid of [...jids].filter((j) => j.endsWith("@lid"))) add(await findMessages({ remoteJid: jid }));

  return [...byId.values()];
}

/** Descarga el archivo de un mensaje (nota de voz, imagen...) a través de Evolution. */
export async function downloadEvolutionMedia(messageId: string): Promise<{ data: Buffer; contentType: string | null }> {
  try {
    const json = await evoPost("/chat/getBase64FromMediaMessage", { message: { key: { id: messageId } }, convertToMp4: false });
    if (!json.base64) throw new Error("Evolution no devolvió el archivo");
    return { data: Buffer.from(json.base64, "base64"), contentType: json.mimetype ?? null };
  } catch (err) {
    if (/Failed to fetch stream|404|410/.test((err as Error).message) && (err as HttpError).status === 400) {
      throw new MediaExpiredError("WhatsApp ya no tiene el archivo (vence a las pocas semanas)");
    }
    throw err;
  }
}
