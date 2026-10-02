import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthError,
  SESSION_COOKIE,
  changePassword,
  clearLoginFailures,
  createSession,
  endSession,
  ensureBootstrapUser,
  logAuthEvent,
  loginBlockedFor,
  normalizeUsername,
  publicUser,
  recordLogin,
  recordLoginFailure,
  roleOf,
  sessionUser,
  verifyLogin,
  withVerifySlot,
} from "./auth.js";
import { createContact, getContact, listContacts, resolveContactId, searchContacts, unreadByContact } from "./chatwoot.js";
import { DATA_DIR, historyPath, webConfig } from "./config.js";
import { answerQuestion, qaModelChain } from "./llm.js";
import { buildHistory, readAudio, readHistoryMessages, readHistoryMeta } from "./history.js";
import { importWhatsAppZip } from "./import-zip.js";
import { exportSenders, guessClientSender, loadExport, writeExportMeta } from "./whatsapp-export.js";
import { handlePanel } from "./panel.js";
import { appendEventToLatest, appendMessages, createThread, getThread, listAllThreads, listThreads } from "./qa-store.js";
import { modelLabel, QuotaError, usageSummary } from "./quota.js";

const { port, bootstrapUser, bootstrapPassword, publicUrl } = webConfig();
const PUBLIC_HOST = publicUrl ? new URL(publicUrl).host : "";
const INDEX_HTML = fileURLToPath(new URL("../public/index.html", import.meta.url));
const LOGIN_HTML = fileURLToPath(new URL("../public/login.html", import.meta.url));
const PANEL_HTML = fileURLToPath(new URL("../public/panel.html", import.meta.url));
const ASSETS_DIR = fileURLToPath(new URL("../public/assets/", import.meta.url));
const MARKED_JS = join(dirname(createRequire(import.meta.url).resolve("marked")), "marked.umd.js");

// ---------------------------------------------------------------------------
// Estado en memoria: solo las actualizaciones de historial en curso (todo lo demás vive en disco).
// ---------------------------------------------------------------------------

interface BuildJob {
  state: "running" | "done" | "error";
  log: string[];
  error?: string;
}
const jobs = new Map<number, BuildJob>();

function startBuild(contactId: number): BuildJob {
  const current = jobs.get(contactId);
  if (current?.state === "running") return current;

  const job: BuildJob = { state: "running", log: [] };
  jobs.set(contactId, job);
  const log = (line: string) => {
    job.log.push(line);
    if (job.log.length > 200) job.log.shift();
    console.log(`[build ${contactId}] ${line}`);
  };
  (async () => {
    const before = await readHistoryMeta(contactId);
    const result = await buildHistory(contactId, log);
    const missing = result.failedAudios + result.pendingAudios;
    log(`Listo: ${result.messages} mensajes.` + (missing ? ` ${missing} nota(s) de voz sin transcribir.` : ""));
    // Queda registrado en la conversación en curso, para que se entienda por qué cambian las respuestas.
    if (before) {
      const delta = result.messages - before.messages;
      await appendEventToLatest(
        contactId,
        `Historial actualizado: ${result.messages} mensajes` + (delta > 0 ? ` (+${delta} nuevos)` : " (sin mensajes nuevos)") +
          (result.recoveredFromWhatsApp ? `, ${result.recoveredFromWhatsApp} recuperados de WhatsApp` : "") + ".",
      );
    }
    job.state = "done";
  })().catch((err: Error) => {
    job.state = "error";
    job.error = err.message;
    log(`Error: ${err.message}`);
  });
  return job;
}

/**
 * El contexto de cada pregunta se arma a partir de lo guardado: el transcript vigente (ya con lo último
 * sincronizado) + las preguntas y respuestas persistidas de esa conversación. No hay estado en memoria
 * que pueda quedar desfasado con el disco, ni se pierde nada al reiniciar el servidor.
 */
async function transcriptFor(contactId: number): Promise<string> {
  if (!(await readHistoryMeta(contactId))) throw new HttpError(409, "Este cliente todavía no tiene historial generado.");
  return readFile(historyPath(contactId), "utf-8");
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- seguridad: HTTPS, origen, cookies, cabeceras ----------

/** El pedido llegó por HTTPS: Traefik lo avisa en x-forwarded-proto (y Cloudflare, si volviera a estar delante, en cf-visitor). */
function viaHttps(req: IncomingMessage): boolean {
  if (/"scheme":"https"/.test(String(req.headers["cf-visitor"] ?? ""))) return true;
  if (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https") return true;
  return !!PUBLIC_HOST && req.headers.host === PUBLIC_HOST && publicUrl.startsWith("https:");
}

/**
 * IP real del visitante. Por internet llega desde Traefik (una IP interna de Docker), que agrega la del
 * visitante al final de x-forwarded-for y descarta la que este mande; por la LAN (puerto 8790), la del
 * socket. No se confía en cf-connecting-ip ni en x-forwarded-for de nadie más: sin Cloudflare delante,
 * cualquiera podría inventarlas para saltarse el límite de intentos de ingreso.
 */
function clientIp(req: IncomingMessage): string {
  const socket = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (/^(172\.(1[6-9]|2\d|3[01])|10)\./.test(socket)) {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return (socket || "?").slice(0, 64);
}

/**
 * Protección CSRF para todo lo que no es GET: el navegador siempre manda Origin (o Sec-Fetch-Site) en
 * esos pedidos, y tiene que ser este mismo sitio. La cookie además es SameSite=Lax.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  const site = req.headers["sec-fetch-site"];
  return site === "same-origin" || site === "none";
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAgeSec: number) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (viaHttps(req)) parts.push("Secure");
  res.appendHeader("set-cookie", parts.join("; "));
}

function clearSessionCookie(req: IncomingMessage, res: ServerResponse) {
  setSessionCookie(req, res, "", 0);
}

function setSecurityHeaders(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (viaHttps(req)) res.setHeader("strict-transport-security", "max-age=31536000");
}

/** Páginas HTML con CSP estricta: solo scripts propios, con un nonce por respuesta para el script en línea. */
async function sendHtml(res: ServerResponse, file: string) {
  const nonce = randomBytes(16).toString("base64");
  const html = (await readFile(file, "utf-8")).replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    // no-transform: que Cloudflare no reescriba la página (Rocket Loader, ofuscación de correos…).
    "cache-control": "no-store, no-transform",
    "content-security-policy": [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
  res.end(html);
}

function redirect(res: ServerResponse, location: string, status = 302) {
  res.writeHead(status, { location, "cache-control": "no-store" });
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "Pedido demasiado grande");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function contactIdParam(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "contact_id inválido");
  return id;
}

async function listHistories() {
  const files = await readdir(DATA_DIR).catch(() => [] as string[]);
  const metas = await Promise.all(
    files.map((f) => /^contact-(\d+)\.meta\.json$/.exec(f)).filter((m) => m !== null).map((m) => readHistoryMeta(Number(m[1]))),
  );
  return metas.filter((m) => m !== null).sort((a, b) => b.generatedAt - a.generatedAt);
}

/** Teléfono en formato internacional (+57...), como lo exige Chatwoot. Un celular colombiano sin indicativo se completa. */
function normalizePhone(raw: unknown): string {
  let phone = String(raw ?? "").trim().replace(/[\s().-]/g, "");
  if (phone.startsWith("00")) phone = "+" + phone.slice(2);
  if (/^3\d{9}$/.test(phone)) phone = "+57" + phone;
  if (!/^\+\d{8,15}$/.test(phone)) throw new HttpError(400, "Escriba el teléfono con indicativo, p. ej. +57 300 123 4567.");
  return phone;
}

/** Acepta lo mismo que la CLI (id, +teléfono, conv:N) y además búsqueda libre por nombre. */
async function findContacts(q: string) {
  const exact = /^(\d+|conv:\d+|\+[\d\s()-]+)$/i.test(q);
  const contacts = exact ? [await getContact(await resolveContactId(q))] : (await searchContacts(q)).slice(0, 15);
  return Promise.all(
    contacts.map(async (c) => ({ id: c.id, name: c.name ?? null, phone: c.phone_number ?? null, hasHistory: !!(await readHistoryMeta(c.id)) })),
  );
}

/**
 * Responde una pregunta y guarda pregunta y respuesta en la conversación. La pregunta se guarda antes
 * de llamar a Gemini: aunque la respuesta falle o se cierre la pestaña, no se pierde.
 *
 * La respuesta sale como NDJSON (un evento JSON por línea): qué modelo está respondiendo, el texto a
 * medida que llega, los cambios de modelo cuando uno falla (con el texto parcial descartado) y el final.
 */
async function streamAnswer(req: IncomingMessage, res: ServerResponse) {
  const { contactId: rawId, threadId, question, model } = await readJson(req);
  const contactId = contactIdParam(String(rawId));
  if (typeof question !== "string" || !question.trim()) throw new HttpError(400, "Falta la pregunta");
  const thread = typeof threadId === "string" ? await getThread(contactId, threadId) : undefined;
  if (!thread) throw new HttpError(404, "Conversación no encontrada");

  const transcript = await transcriptFor(contactId);
  const text = question.trim();
  await appendMessages(contactId, thread.id, [{ role: "user", text, at: Date.now() }]);

  // no-transform: sin esto Cloudflare puede comprimir y juntar los fragmentos, y el texto dejaría de verse en vivo.
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
  const send = (event: object) => res.write(`${JSON.stringify(event)}\n`);

  let answer = "";
  const notes: string[] = [];
  try {
    for await (const event of answerQuestion(transcript, thread.messages, text, typeof model === "string" ? model : undefined)) {
      if (event.type === "delta") answer += event.text;
      if (event.type === "retry") {
        notes.push(`${event.failed}: ${event.reason}`);
        if (event.discardPartial) answer = "";
      }
      send(event);
      if (event.type === "done") {
        await appendMessages(contactId, thread.id, [
          { role: "model", text: answer, at: Date.now(), model: event.model, ...(notes.length ? { notes } : {}) },
        ]);
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    send({ type: "error", message });
    await appendMessages(contactId, thread.id, [{ role: "model", text: `Error: ${message}`, at: Date.now(), error: true, notes }]);
  }
  res.end();
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/") return sendHtml(res, INDEX_HTML);
  if (req.method === "GET" && path === "/vendor/marked.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, max-age=86400" });
    return res.end(await readFile(MARKED_JS));
  }
  if (req.method === "GET" && path === "/api/histories") return sendJson(res, 200, await listHistories());
  if (req.method === "GET" && path === "/api/models") {
    const chain = await qaModelChain().catch(() => [] as string[]);
    return sendJson(res, 200, { chain, labels: Object.fromEntries(chain.map((k) => [k, modelLabel(k)])) });
  }
  if (req.method === "GET" && path === "/api/threads") {
    const [threads, histories] = await Promise.all([listAllThreads(), listHistories()]);
    const names = new Map(histories.map((m) => [m.contactId, m.name]));
    return sendJson(res, 200, threads.map((t) => ({ ...t, name: names.get(t.contactId) ?? null })));
  }
  if (req.method === "GET" && path === "/api/contacts/all") {
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const [{ contacts, total }, unread] = await Promise.all([listContacts(page), unreadByContact().catch(() => new Map<number, number>())]);
    const analyzed = new Set((await listHistories()).map((m) => m.contactId));
    return sendJson(res, 200, {
      total,
      page,
      contacts: contacts.map((c) => ({
        id: c.id,
        name: c.name ?? null,
        phone: c.phone_number ?? null,
        lastActivityAt: c.last_activity_at ?? null,
        hasHistory: analyzed.has(c.id),
        unread: unread.get(c.id) ?? 0,
      })),
    });
  }
  if (req.method === "GET" && path === "/api/usage") return sendJson(res, 200, await usageSummary(await qaModelChain().catch(() => [])));
  // Contacto que no está en Chatwoot: se crea para poder importar y analizar su chat.
  if (req.method === "POST" && path === "/api/contacts") {
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) throw new HttpError(400, "Escriba el nombre del contacto.");
    const phone = normalizePhone(body.phone);
    const created = await createContact(name, phone);
    console.log(`[contactos] ${created.existed ? "ya existía" : "creado"} ${created.id} (${phone})`);
    return sendJson(res, created.existed ? 200 : 201, { id: created.id, name, phone, existed: created.existed });
  }
  if (req.method === "GET" && path === "/api/contacts") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) throw new HttpError(400, "Escriba al menos 2 caracteres");
    return sendJson(res, 200, await findContacts(q));
  }

  const history = /^\/api\/history\/(\d+)(?:\/(build|messages|transcript|import|audio|export-client))?$/.exec(path);
  if (history) {
    const contactId = contactIdParam(history[1]);
    const sub = history[2];
    if (sub === "build") {
      if (req.method === "POST") return sendJson(res, 202, startBuild(contactId));
      if (req.method === "GET") return sendJson(res, 200, jobs.get(contactId) ?? null);
    } else if (sub === "messages" && req.method === "GET") {
      // Para el panel de chat: sin las rutas internas de los audios (se piden por clave).
      const messages = (await readHistoryMessages(contactId)) ?? [];
      return sendJson(res, 200, messages.map(({ audio, ...m }) => (audio ? { ...m, audioKey: audio.key } : m)));
    } else if (sub === "audio" && req.method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      const found = (await readHistoryMessages(contactId))?.find((m) => m.audio?.key === key)?.audio;
      if (!found) throw new HttpError(404, "Nota de voz no encontrada");
      const { data, contentType } = await readAudio(found.source).catch((err: Error) => {
        throw new HttpError(404, `No se pudo obtener el audio: ${err.message.slice(0, 120)}`);
      });
      res.writeHead(200, { "content-type": contentType, "content-length": data.length, "cache-control": "private, max-age=3600" });
      return res.end(data);
    } else if (sub === "transcript" && req.method === "GET") {
      const text = await readFile(historyPath(contactId), "utf-8").catch(() => null);
      if (!text) throw new HttpError(404, "Este cliente todavía no tiene historial generado.");
      const meta = await readHistoryMeta(contactId);
      const name = (meta?.name ?? `contacto-${contactId}`).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="historial-${name}.txt"` });
      return res.end(text);
    } else if (sub === "import" && req.method === "POST") {
      // Zip de "Exportar chat" de WhatsApp: se guarda como tercera fuente y se actualiza el historial.
      const result = await importWhatsAppZip(contactId, req).catch((err: Error) => {
        throw new HttpError(400, err.message);
      });
      // Quién escribe en el chat, para que el usuario confirme quién es el cliente si hace falta.
      const data = await loadExport(contactId);
      const senders = exportSenders(data?.messages ?? []);
      const contact = await getContact(contactId).catch(() => null);
      const guess = guessClientSender(senders, { name: contact?.name, phone: contact?.phone_number });
      if (url.searchParams.get("build") !== "0") startBuild(contactId);
      return sendJson(res, 202, { ...result, messages: data?.messages.length ?? 0, senders, guess });
    } else if (sub === "export-client" && req.method === "POST") {
      const { sender } = await readJson(req);
      const data = await loadExport(contactId);
      if (!data) throw new HttpError(404, "Este contacto no tiene un chat importado.");
      if (typeof sender !== "string" || !data.messages.some((m) => m.sender === sender)) throw new HttpError(400, "Esa persona no aparece en el chat importado.");
      await writeExportMeta(contactId, { clientSender: sender });
      return sendJson(res, 200, { ok: true });
    } else if (!sub && req.method === "GET") {
      const meta = await readHistoryMeta(contactId);
      const transcript = meta ? await readFile(historyPath(contactId), "utf-8").catch(() => null) : null;
      return sendJson(res, 200, { meta, transcript, job: jobs.get(contactId) ?? null });
    }
  }

  // Conversaciones guardadas con Gemini sobre un cliente.
  const qa = /^\/api\/qa\/(\d+)(\/threads)?$/.exec(path);
  if (qa) {
    const contactId = contactIdParam(qa[1]);
    if (!qa[2] && req.method === "GET") return sendJson(res, 200, await listThreads(contactId));
    if (qa[2] && req.method === "POST") return sendJson(res, 201, await createThread(contactId));
  }

  if (req.method === "POST" && path === "/api/ask") return streamAnswer(req, res);

  throw new HttpError(404, "No encontrado");
}

const logName = (s: string) => JSON.stringify(s.slice(0, 64));

async function login(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const username = normalizeUsername(body.username);
  const ip = clientIp(req);
  const wait = loginBlockedFor(ip, username);
  const userAgent = String(req.headers["user-agent"] ?? "");
  if (wait) {
    logAuthEvent({ at: Date.now(), username, ip, result: "blocked", userAgent });
    res.setHeader("retry-after", String(wait));
    throw new HttpError(429, `Demasiados intentos fallidos. Intente de nuevo en ${Math.ceil(wait / 60)} min.`);
  }
  const user = await withVerifySlot(() => verifyLogin(username, body.password));
  if (!user) {
    recordLoginFailure(ip, username);
    logAuthEvent({ at: Date.now(), username, ip, result: "fail", userAgent });
    console.warn(`[auth] ingreso fallido usuario=${logName(username)} ip=${ip}`);
    throw new HttpError(401, "Usuario o contraseña incorrectos.");
  }
  clearLoginFailures(ip, username);
  logAuthEvent({ at: Date.now(), username: user.username, ip, result: "ok", userAgent });
  await recordLogin(user.username);
  const { token, maxAgeSec } = await createSession(user, ip, userAgent);
  setSessionCookie(req, res, token, maxAgeSec);
  console.log(`[auth] ingreso usuario=${logName(user.username)} ip=${ip}`);
  return sendJson(res, 200, publicUser(user));
}

/** Rutas públicas, inicio de sesión y, para todo lo demás, sesión obligatoria. */
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Por internet, siempre HTTPS (aunque Cloudflare no tenga activado "Always Use HTTPS").
  if (/"scheme":"http"/.test(String(req.headers["cf-visitor"] ?? ""))) return redirect(res, `https://${req.headers.host}${req.url}`, 301);
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) throw new HttpError(403, "Origen no permitido.");

  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end("ok");
  }
  // Logo, favicon (también los usa la página de ingreso) y logos oficiales de las integraciones.
  const asset = /^\/assets\/((?:brands\/)?[\w.-]+\.(png|svg))$/.exec(path);
  if (req.method === "GET" && (asset || path === "/favicon.ico")) {
    const file = await readFile(resolve(ASSETS_DIR, asset ? asset[1] : "favicon-32.png")).catch(() => null);
    if (!file) throw new HttpError(404, "No encontrado");
    const svg = asset?.[2] === "svg";
    res.writeHead(200, {
      "content-type": svg ? "image/svg+xml" : "image/png",
      "cache-control": "public, max-age=86400",
      // Un SVG abierto directamente no puede ejecutar nada.
      ...(svg ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}),
    });
    return res.end(file);
  }

  const token = parseCookies(req)[SESSION_COOKIE];
  const session = await sessionUser(token);
  if (session?.renewed) setSessionCookie(req, res, token!, session.maxAgeSec);

  if (req.method === "POST" && path === "/api/login") return login(req, res);
  if (req.method === "POST" && path === "/api/logout") {
    await endSession(token);
    clearSessionCookie(req, res);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && path === "/login") return session ? redirect(res, "/") : sendHtml(res, LOGIN_HTML);

  if (!session) {
    if (req.method === "GET" && !path.startsWith("/api/")) return redirect(res, path === "/panel" ? "/login?next=panel" : "/login");
    throw new HttpError(401, "Su sesión venció. Vuelva a ingresar.");
  }

  const { user } = session;
  if (req.method === "GET" && path === "/api/me") return sendJson(res, 200, publicUser(user));
  if (req.method === "POST" && path === "/api/password") {
    const { current, next } = await readJson(req);
    await changePassword(user.username, current, next, token);
    console.log(`[auth] cambio de contraseña usuario=${logName(user.username)} ip=${clientIp(req)}`);
    return sendJson(res, 200, { ok: true });
  }
  // La contraseña inicial se compartió por fuera: hasta cambiarla, solo se puede cambiarla o salir.
  if (user.mustChangePassword && path.startsWith("/api/")) throw new HttpError(403, "Antes de seguir, cambie la contraseña inicial.");
  if (req.method === "GET" && path === "/panel") return roleOf(user) === "admin" && !user.mustChangePassword ? sendHtml(res, PANEL_HTML) : redirect(res, "/");
  if (path.startsWith("/api/panel/")) {
    if (roleOf(user) !== "admin") throw new HttpError(403, "Solo los administradores pueden usar el Panel de control.");
    const handled = await handlePanel({ req, res, path, user, token: token!, body: () => readJson(req), send: sendJson });
    if (handled) return;
    throw new HttpError(404, "No encontrado");
  }
  return route(req, res);
}

const bootstrapped = await ensureBootstrapUser(bootstrapUser, bootstrapPassword);
if (bootstrapped) console.log(`[auth] Se creó el usuario "${bootstrapped}" con WEB_PASSWORD; deberá cambiar la contraseña al ingresar.`);

createServer(async (req, res) => {
  try {
    setSecurityHeaders(req, res);
    await handle(req, res);
  } catch (err) {
    const status =
      err instanceof HttpError || err instanceof AuthError
        ? err.status
        : err instanceof QuotaError
          ? 429
          : ((err as { status?: number }).status ?? 500);
    const message = (err as Error).message ?? String(err);
    // Los errores del usuario (4xx: datos inválidos, permisos...) no son fallas del servidor: no ensucian el log.
    if (!(status >= 400 && status < 500)) console.error(err);
    if (res.headersSent) return res.end();
    sendJson(res, status >= 400 && status < 600 ? status : 500, { error: message });
  }
}).listen(port, () => {
  console.log(`Interfaz web escuchando en el puerto ${port}${publicUrl ? ` · pública en ${publicUrl}` : ""}.`);
});
