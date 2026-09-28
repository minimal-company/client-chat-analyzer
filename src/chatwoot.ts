import { chatwootConfig } from "./config.js";
import { HttpError, withRetry } from "./retry.js";
import type { ChatwootContact, ChatwootConversation, ChatwootMessage } from "./types.js";

/**
 * /contacts/:id/conversations no tiene paginación: corta en 20 (Chatwoot 4.x) o 25 (versiones
 * más nuevas). Si devuelve al menos esta cantidad, puede haber más.
 */
const CONVERSATIONS_MIN_CAP = 20;

function accountUrl(path: string): URL {
  const { baseUrl, accountId } = chatwootConfig();
  return new URL(`${baseUrl}/api/v1/accounts/${accountId}${path}`);
}

async function chatwootFetch(url: URL): Promise<any> {
  return withRetry(`Chatwoot ${url.pathname}`, async () => {
    const res = await fetch(url, { headers: { api_access_token: chatwootConfig().apiToken } });
    if (!res.ok) {
      throw new HttpError(`Chatwoot respondió ${res.status} en ${url}: ${await res.text()}`, res.status);
    }
    return res.json();
  });
}

export async function getContact(contactId: number): Promise<ChatwootContact> {
  const json = await chatwootFetch(accountUrl(`/contacts/${contactId}`));
  return json.payload;
}

/**
 * Acepta un contact_id ("123"), un teléfono con "+" ("+573001234567") o una conversación
 * ("conv:18", el número que Chatwoot muestra como #18), que se resuelve a su contacto.
 * El "+" es obligatorio para teléfonos: un número sin él es indistinguible de un id.
 */
export async function resolveContactId(arg: string): Promise<number> {
  if (/^\d+$/.test(arg)) return Number(arg);

  const conversation = /^conv:(\d+)$/i.exec(arg);
  if (conversation) {
    const json = await chatwootFetch(accountUrl(`/conversations/${conversation[1]}`));
    const contactId = json.meta?.sender?.id;
    if (typeof contactId !== "number") throw new Error(`La conversación ${conversation[1]} no tiene contacto asociado`);
    return contactId;
  }

  const phone = arg.replace(/[\s()-]/g, "");
  if (!/^\+\d{6,15}$/.test(phone)) {
    throw new Error(`"${arg}" no es un contact_id, un teléfono con formato +<código país><número> ni conv:<número>`);
  }

  const url = accountUrl("/contacts/search");
  url.searchParams.set("q", phone);
  const json = await chatwootFetch(url);
  const matches = ((json.payload ?? []) as ChatwootContact[]).filter((c) => c.phone_number === phone);

  if (matches.length === 0) throw new Error(`No hay ningún contacto con teléfono ${phone}`);
  if (matches.length > 1) {
    const ids = matches.map((c) => `${c.id} (${c.name ?? "sin nombre"})`).join(", ");
    throw new Error(`Hay ${matches.length} contactos con teléfono ${phone}: ${ids}. Use el contact_id.`);
  }
  return matches[0].id;
}

/** Una página de todos los contactos de la cuenta, con actividad más reciente primero. */
export async function listContacts(page: number): Promise<{ contacts: (ChatwootContact & { last_activity_at?: number | null })[]; total: number }> {
  const url = accountUrl("/contacts");
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "-last_activity_at");
  const json = await chatwootFetch(url);
  return { contacts: json.payload ?? [], total: json.meta?.count ?? 0 };
}

let unreadCache: { at: number; map: Map<number, number> } | null = null;

/** Mensajes sin leer por contacto (según Chatwoot), para las insignias de la lista. Caché de 1 minuto. */
export async function unreadByContact(): Promise<Map<number, number>> {
  if (unreadCache && Date.now() - unreadCache.at < 60_000) return unreadCache.map;
  const map = new Map<number, number>();
  for (let page = 1; page <= 4; page++) {
    const url = accountUrl("/conversations");
    url.searchParams.set("status", "all");
    url.searchParams.set("page", String(page));
    const list: { unread_count?: number; meta?: { sender?: { id?: number } } }[] = (await chatwootFetch(url)).data?.payload ?? [];
    for (const c of list) {
      const id = c.meta?.sender?.id;
      if (id && c.unread_count) map.set(id, (map.get(id) ?? 0) + c.unread_count);
    }
    if (list.length < 25) break; // última página
  }
  unreadCache = { at: Date.now(), map };
  return map;
}

/**
 * Crea un contacto (sin conversaciones) para poder analizar un chat que no está en Chatwoot. Si el
 * teléfono ya existe, devuelve ese contacto en vez de fallar.
 */
export async function createContact(name: string, phone: string): Promise<{ id: number; existed: boolean }> {
  const url = accountUrl("/contacts");
  const res = await fetch(url, {
    method: "POST",
    headers: { api_access_token: chatwootConfig().apiToken, "content-type": "application/json" },
    body: JSON.stringify({ name, phone_number: phone }),
  });
  const text = await res.text();
  if (res.ok) {
    const json = JSON.parse(text);
    const contact = json.payload?.contact ?? json.payload ?? json;
    if (!contact?.id) throw new HttpError("Chatwoot creó el contacto pero no devolvió su id", 502);
    return { id: contact.id, existed: false };
  }
  if (res.status === 422) {
    const digits = phone.replace(/\D/g, "");
    const found = (await searchContacts(phone)).find((c) => (c.phone_number ?? "").replace(/\D/g, "") === digits);
    if (found) return { id: found.id, existed: true };
  }
  let message = text.slice(0, 200);
  try {
    message = JSON.parse(text).message ?? message;
  } catch {
    // no era JSON
  }
  throw new HttpError(`Chatwoot no pudo crear el contacto: ${message}`, res.status === 422 ? 400 : 502);
}

/** Búsqueda libre de contactos (nombre, teléfono o email), como el buscador de Chatwoot. */
export async function searchContacts(query: string): Promise<ChatwootContact[]> {
  const url = accountUrl("/contacts/search");
  url.searchParams.set("q", query);
  return (await chatwootFetch(url)).payload ?? [];
}

function isOlder(a: ChatwootConversation, b: ChatwootConversation): boolean {
  return a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

/**
 * Chatwoot nuevo: ?conversation_id=X devuelve X con su vecina anterior y posterior por fecha de
 * creación. Se camina la cadena hacia ambos extremos desde una conversación conocida.
 */
async function walkNeighbours(path: string, start: ChatwootConversation, byId: Map<number, ChatwootConversation>) {
  for (const direction of ["older", "newer"] as const) {
    let current = start;
    while (true) {
      const url = accountUrl(path);
      url.searchParams.set("conversation_id", String(current.id));
      const page: ChatwootConversation[] = (await chatwootFetch(url)).payload ?? [];
      const next = page.find((c) => (direction === "older" ? isOlder(c, current) : isOlder(current, c)));
      if (!next) break;
      byId.set(next.id, next);
      current = next;
    }
  }
}

/**
 * Chatwoot 4.x no tiene forma de paginar las conversaciones de un contacto: se recorren todas
 * las de la cuenta (25 por página) y se filtran por contacto. Más lento, pero completo.
 */
async function scanAccountConversations(contactId: number, byId: Map<number, ChatwootConversation>) {
  for (let page = 1; ; page++) {
    const url = accountUrl("/conversations");
    url.searchParams.set("status", "all");
    url.searchParams.set("assignee_type", "all");
    url.searchParams.set("page", String(page));
    const batch: any[] = (await chatwootFetch(url)).data?.payload ?? [];
    if (batch.length === 0) return;
    for (const c of batch) if (c.meta?.sender?.id === contactId) byId.set(c.id, c);
  }
}

/**
 * Todas las conversaciones del contacto (Chatwoot abre una nueva por sesión resuelta).
 * Solo ve inboxes a los que tiene acceso el usuario del token (un admin ve todos).
 */
export async function getContactConversations(
  contactId: number,
  log: (line: string) => void = console.log,
): Promise<ChatwootConversation[]> {
  const path = `/contacts/${contactId}/conversations`;
  const first: ChatwootConversation[] = (await chatwootFetch(accountUrl(path))).payload ?? [];
  if (first.length < CONVERSATIONS_MIN_CAP) return first;

  const byId = new Map(first.map((c) => [c.id, c]));

  // Las versiones que no conocen ?conversation_id lo ignoran y repiten el listado completo.
  const probe = accountUrl(path);
  probe.searchParams.set("conversation_id", String(first[0].id));
  const probed: ChatwootConversation[] = (await chatwootFetch(probe)).payload ?? [];

  if (probed.length <= 3) {
    await walkNeighbours(path, first[0], byId);
  } else {
    log(`El listado del contacto corta en ${first.length}; recorriendo todas las conversaciones de la cuenta...`);
    await scanAccountConversations(contactId, byId);
  }
  return [...byId.values()];
}

/** Todos los mensajes de una conversación, paginando hacia atrás (20 por página) hasta agotar el historial. */
export async function getAllMessages(conversationId: number): Promise<ChatwootMessage[]> {
  const all: ChatwootMessage[] = [];
  let before: number | undefined;

  while (true) {
    const url = accountUrl(`/conversations/${conversationId}/messages`);
    if (before !== undefined) url.searchParams.set("before", String(before));

    const batch: ChatwootMessage[] = (await chatwootFetch(url)).payload ?? [];
    const oldest = Math.min(...batch.map((m) => m.id));
    if (batch.length === 0 || (before !== undefined && oldest >= before)) break;

    all.push(...batch);
    before = oldest;
  }

  return all;
}

/**
 * Chatwoot arma `data_url` con su FRONTEND_URL público. Si es un archivo propio de Chatwoot
 * (/rails/active_storage/...), se pide a CHATWOOT_BASE_URL: dentro de Docker eso evita salir a
 * internet y volver por Cloudflare. URLs externas (p. ej. Instagram) quedan como están.
 */
function internalAttachmentUrl(dataUrl: string): string {
  const url = new URL(dataUrl);
  if (!url.pathname.startsWith("/rails/active_storage/")) return dataUrl;
  return `${chatwootConfig().baseUrl}${url.pathname}${url.search}`;
}

/**
 * Descarga un adjunto. Es una URL firmada de ActiveStorage que no requiere auth y puede
 * redirigir a un storage externo (S3), así que NO se manda el token: fetch reenviaría ese
 * header personalizado al host del redirect.
 */
export async function downloadAttachment(dataUrl: string): Promise<{ data: Buffer; contentType: string | null }> {
  const url = internalAttachmentUrl(dataUrl);
  return withRetry("descarga de adjunto", async () => {
    const res = await fetch(url);
    if (!res.ok) throw new HttpError(`No se pudo descargar el adjunto (${res.status}): ${url}`, res.status);
    return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  });
}
