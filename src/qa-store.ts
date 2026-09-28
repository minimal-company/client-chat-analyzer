import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.js";

// Preguntas y respuestas de la interfaz web, persistidas por cliente en data/qa/contact-<id>.json.
// Sobreviven a recargas de página y reinicios del servidor; de acá se reconstruye el contexto del chat
// con Gemini cuando hace falta (servidor reiniciado o historial actualizado).

export interface QaMessage {
  role: "user" | "model" | "event"; // event: aviso del sistema (p. ej. "historial actualizado")
  text: string;
  at: number; // epoch ms
  error?: boolean; // respuesta fallida o cortada: se muestra, pero no se usa como contexto
  model?: string; // modelo que respondió
  notes?: string[]; // modelos que fallaron antes (p. ej. "gemini-3.5-flash: 503: Google está saturado")
}

export interface QaThread {
  id: string;
  createdAt: number;
  messages: QaMessage[];
}

const QA_DIR = resolve(DATA_DIR, "qa");
const filePath = (contactId: number) => resolve(QA_DIR, `contact-${contactId}.json`);

async function load(contactId: number): Promise<QaThread[]> {
  const raw = await readFile(filePath(contactId), "utf-8").catch(() => null);
  return raw ? (JSON.parse(raw).threads as QaThread[]) : [];
}

async function save(contactId: number, threads: QaThread[]) {
  await mkdir(QA_DIR, { recursive: true });
  const tmp = `${filePath(contactId)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ threads }, null, 2), "utf-8");
  await rename(tmp, filePath(contactId)); // escritura atómica: nunca queda un archivo a medias
}

// Una escritura a la vez por cliente, para que dos pedidos simultáneos no se pisen.
const locks = new Map<number, Promise<unknown>>();
function withLock<T>(contactId: number, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(contactId) ?? Promise.resolve()).then(fn);
  locks.set(contactId, run.catch(() => {}));
  return run;
}

export function listThreads(contactId: number): Promise<QaThread[]> {
  return withLock(contactId, () => load(contactId));
}

export function getThread(contactId: number, threadId: string): Promise<QaThread | undefined> {
  return withLock(contactId, async () => (await load(contactId)).find((t) => t.id === threadId));
}

export function createThread(contactId: number): Promise<QaThread> {
  return withLock(contactId, async () => {
    const threads = await load(contactId);
    const thread: QaThread = { id: randomUUID(), createdAt: Date.now(), messages: [] };
    threads.push(thread);
    await save(contactId, threads);
    return thread;
  });
}

export function appendMessages(contactId: number, threadId: string, messages: QaMessage[]): Promise<void> {
  return withLock(contactId, async () => {
    const threads = await load(contactId);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new Error("Conversación no encontrada");
    thread.messages.push(...messages);
    await save(contactId, threads);
  });
}

export interface ThreadSummary {
  contactId: number;
  threadId: string;
  createdAt: number;
  updatedAt: number;
  questions: number;
  firstQuestion: string;
  lastQuestion: string;
}

/** Todas las conversaciones con preguntas, de todos los clientes, la más reciente primero. */
export async function listAllThreads(): Promise<ThreadSummary[]> {
  const files = await readdir(QA_DIR).catch(() => [] as string[]);
  const out: ThreadSummary[] = [];
  for (const file of files) {
    const id = Number(/^contact-(\d+)\.json$/.exec(file)?.[1]);
    if (!id) continue;
    for (const t of await listThreads(id)) {
      const questions = t.messages.filter((m) => m.role === "user");
      if (!questions.length) continue;
      out.push({
        contactId: id,
        threadId: t.id,
        createdAt: t.createdAt,
        updatedAt: Math.max(t.createdAt, ...t.messages.map((m) => m.at)),
        questions: questions.length,
        firstQuestion: questions[0].text.slice(0, 300),
        lastQuestion: questions.at(-1)!.text.slice(0, 300),
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Deja un aviso en la conversación más reciente del cliente (si tiene alguna), p. ej. tras actualizar. */
export function appendEventToLatest(contactId: number, text: string): Promise<void> {
  return withLock(contactId, async () => {
    const threads = await load(contactId);
    const latest = threads.at(-1);
    if (!latest || latest.messages.length === 0) return;
    latest.messages.push({ role: "event", text, at: Date.now() });
    await save(contactId, threads);
  });
}
