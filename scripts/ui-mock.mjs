#!/usr/bin/env node
// Sirve la interfaz real (public/) con los casos bajados por scripts/case.mjs y un usuario ya
// "ingresado", para revisar cambios visuales sin contraseñas, sin servidor y sin gastar IA.
// Las preguntas al agente, las notas de voz y el Panel de control no funcionan acá.
//
//   node scripts/case.mjs pull 9
//   node scripts/ui-mock.mjs [--cases <dir>] [--port 8798]      →  http://127.0.0.1:8798/#/c/9
//
// Necesita `npm install` (usa node_modules/marked, igual que el servidor real).
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const CASES = resolve(opt("--cases", process.env.CCA_CASES_DIR || join(tmpdir(), "cca-cases")));
const PORT = Number(opt("--port", 8798));

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const caseIds = () =>
  existsSync(CASES) ? readdirSync(CASES).filter((d) => /^\d+$/.test(d) && existsSync(join(CASES, d, `contact-${d}.meta.json`))).map(Number) : [];
const file = (id, name) => join(CASES, String(id), name);
const meta = (id) => readJson(file(id, `contact-${id}.meta.json`));
const threads = (id) => (existsSync(file(id, "qa.json")) ? readJson(file(id, "qa.json")).threads : []);

function threadSummaries() {
  const out = [];
  for (const id of caseIds()) {
    for (const t of threads(id)) {
      const questions = t.messages.filter((m) => m.role === "user");
      if (!questions.length) continue;
      out.push({
        contactId: id,
        name: meta(id).name ?? null,
        threadId: t.id,
        createdAt: t.createdAt,
        updatedAt: Math.max(t.createdAt, ...t.messages.map((m) => m.at)),
        questions: questions.length,
        firstQuestion: questions[0].text.slice(0, 300),
        lastQuestion: questions.at(-1).text.slice(0, 300),
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

const TYPES = { ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const json = (body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const html = (name) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(ROOT, "public", name)));
  };

  if (path === "/") return html("index.html");
  if (path === "/login") return html("login.html");
  if (path === "/vendor/marked.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    return res.end(readFileSync(join(ROOT, "node_modules/marked/lib/marked.umd.js")));
  }
  if (path.startsWith("/assets/") && !path.includes("..")) {
    const full = join(ROOT, "public", path);
    if (!existsSync(full)) return json({ error: "No encontrado" }, 404);
    res.writeHead(200, { "content-type": TYPES[extname(full)] ?? "application/octet-stream" });
    return res.end(readFileSync(full));
  }

  if (path === "/api/me") return json({ username: "demo", name: "Usuario de prueba", role: "admin", mustChangePassword: false });
  if (path === "/api/histories") return json(caseIds().map(meta).sort((a, b) => b.generatedAt - a.generatedAt));
  if (path === "/api/threads") return json(threadSummaries());
  if (path === "/api/models") return json({ chain: ["gemini-3.5-flash"], labels: { "gemini-3.5-flash": "3.5-flash" } });
  if (path === "/api/usage") return json({ resetsAt: "02:00", title: "Uso de IA hoy (simulado)", models: [] });
  if (path === "/api/contacts/all") {
    const contacts = caseIds().map((id) => {
      const m = meta(id);
      return { id, name: m.name ?? null, phone: m.phone ?? null, lastActivityAt: Math.round(m.generatedAt / 1000), hasHistory: true, unread: 0 };
    });
    return json({ total: contacts.length, page: 1, contacts });
  }

  const history = /^\/api\/history\/(\d+)(?:\/(messages))?$/.exec(path);
  if (history && caseIds().includes(Number(history[1]))) {
    const id = Number(history[1]);
    if (history[2] === "messages") {
      const messages = readJson(file(id, `contact-${id}.messages.json`));
      return json(messages.map(({ audio, ...m }) => (audio ? { ...m, audioKey: audio.key } : m)));
    }
    // Se presenta como recién generado: con la fecha real, la interfaz intentaría actualizarlo sola.
    const fresh = { ...meta(id), generatedAt: Date.now() - 60_000 };
    return json({ meta: fresh, transcript: readFileSync(file(id, `contact-${id}.txt`), "utf8"), job: null });
  }
  const qa = /^\/api\/qa\/(\d+)$/.exec(path);
  if (qa) return json(threads(Number(qa[1])));

  json({ error: "No disponible en el simulador" }, 404);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Interfaz simulada en http://127.0.0.1:${PORT}  (casos: ${CASES}; ${caseIds().length} bajados)`);
});
