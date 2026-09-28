#!/usr/bin/env node
// Lee el caso de un cliente (transcript, mensajes y conversaciones con el agente de IA) desde el
// servidor por SSH, sin modificar nada allá, para analizarlo en otra sesión (p. ej. con Claude Code).
// No usa ninguna IA: solo lee archivos.
//
//   node scripts/case.mjs list                       clientes con historial y conversaciones guardadas
//   node scripts/case.mjs pull <id> [--out <dir>]    copia los archivos del cliente a una carpeta local
//   node scripts/case.mjs questions <id>             todas las preguntas al agente, numeradas
//   node scripts/case.mjs qa <id> <n|n-m|n,m,...>    pregunta y respuesta completas
//   node scripts/case.mjs stats <id>                 tiempos de respuesta de cada lado y esperas de más de 24 h
//
// questions, qa y stats bajan el caso si no está en la carpeta local; --refresh lo vuelve a bajar.
// Variables de entorno (valores por defecto entre paréntesis):
//   CCA_SSH          usuario@servidor (vaioserver@192.168.1.36)
//   CCA_SSH_KEY      llave privada (~/.ssh/vaioserver_ed25519)
//   CCA_REMOTE_DATA  carpeta data/ en el servidor, relativa al home remoto (client-chat-analyzer/data)
//   CCA_CASES_DIR    carpeta local de casos (<carpeta temporal del sistema>/cca-cases)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SSH = process.env.CCA_SSH || "vaioserver@192.168.1.36";
const KEY = (process.env.CCA_SSH_KEY || "~/.ssh/vaioserver_ed25519").replace(/^~(?=[/\\])/, homedir());
const REMOTE = process.env.CCA_REMOTE_DATA || "client-chat-analyzer/data";
const TZ = "America/Bogota";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const opts = { refresh: false, out: undefined };
const pos = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--refresh") opts.refresh = true;
  else if (argv[i] === "--out") opts.out = argv[++i];
  else if (argv[i].startsWith("--")) fail(`Opción desconocida: ${argv[i]}`);
  else pos.push(argv[i]);
}
const casesDir = resolve(opts.out || process.env.CCA_CASES_DIR || join(tmpdir(), "cca-cases"));

// ---------- servidor ----------
function remote(command) {
  const r = spawnSync("ssh", ["-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SSH, command], { maxBuffer: 1024 ** 3 });
  if (r.error) fail(`No se pudo ejecutar ssh: ${r.error.message}`);
  if (r.status !== 0) fail(`ssh terminó con código ${r.status}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

// ---------- formato ----------
/** "2026-08-05 11:06" en hora de Colombia, el mismo formato del transcript. */
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16);
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1) + "…" : text);
function duration(seconds) {
  const h = seconds / 3600;
  return h >= 48 ? `${Math.floor(h / 24)} d ${Math.round(h % 24)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(seconds / 60)} min`;
}

// ---------- casos locales ----------
function contactId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) fail(`contact_id inválido: ${raw ?? "(falta)"}`);
  return id;
}

function pull(id) {
  const dir = join(casesDir, String(id));
  mkdirSync(dir, { recursive: true });
  const exists = remote(`test -f ${REMOTE}/contact-${id}.txt && echo si || echo no`).toString().trim();
  if (exists !== "si") fail(`El contacto ${id} no tiene historial generado en el servidor.`);
  for (const f of [`contact-${id}.txt`, `contact-${id}.meta.json`, `contact-${id}.messages.json`]) {
    writeFileSync(join(dir, f), remote(`cat ${REMOTE}/${f}`));
  }
  const qa = remote(`cat ${REMOTE}/qa/contact-${id}.json 2>/dev/null || true`);
  if (qa.length) writeFileSync(join(dir, "qa.json"), qa);
  return dir;
}

function caseDir(id) {
  const dir = join(casesDir, String(id));
  return !opts.refresh && existsSync(join(dir, `contact-${id}.txt`)) ? dir : pull(id);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function threadsOf(dir) {
  const path = join(dir, "qa.json");
  return existsSync(path) ? readJson(path).threads : [];
}

/** Preguntas de todas las conversaciones, numeradas en orden (1, 2, 3… sin reiniciar por conversación). */
function numberedQuestions(threads) {
  const out = [];
  threads.forEach((thread, t) => {
    thread.messages.forEach((m, i) => {
      if (m.role !== "user") return;
      let answer = null;
      for (let j = i + 1; j < thread.messages.length && thread.messages[j].role !== "user"; j++) {
        if (thread.messages[j].role === "model") answer = thread.messages[j];
      }
      out.push({ n: out.length + 1, thread: t + 1, question: m, answer });
    });
  });
  return out;
}

function parseSelection(sel, max) {
  if (!sel) fail("Indique qué preguntas: 12, 10-15 o 3,7,20-22");
  const picked = new Set();
  for (const part of sel.split(",")) {
    const [a, b] = part.split("-").map(Number);
    if (!a || (part.includes("-") && !b)) fail(`Selección inválida: ${part}`);
    for (let n = a; n <= (b || a); n++) if (n <= max) picked.add(n);
  }
  return picked;
}

// ---------- comandos ----------
function list() {
  const lines = remote(
    `cd ${REMOTE} && for f in contact-*.meta.json; do printf '%s\\t' "$f"; tr -d '\\n' < "$f"; echo; done; ` +
      `for f in qa/contact-*.json; do [ -f "$f" ] && { printf '%s\\t' "$f"; tr -d '\\n' < "$f"; echo; }; done`,
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const metas = new Map();
  const qa = new Map();
  for (const line of lines) {
    const tab = line.indexOf("\t");
    const file = line.slice(0, tab);
    const id = Number(/contact-(\d+)/.exec(file)?.[1]);
    const data = JSON.parse(line.slice(tab + 1));
    if (file.startsWith("qa/")) qa.set(id, numberedQuestions(data.threads).length > 0 ? data.threads : []);
    else metas.set(id, data);
  }
  console.log("ID\tCliente\tTeléfono\tMensajes\tNotas de voz\tHistorial generado\tConversaciones con el agente");
  for (const [id, m] of [...metas].sort((a, b) => b[1].generatedAt - a[1].generatedAt)) {
    const threads = qa.get(id) ?? [];
    const questions = numberedQuestions(threads);
    const last = questions.at(-1)?.question.at;
    const convs = questions.length ? `${threads.length} (${questions.length} preguntas, última ${stamp(last)})` : "—";
    console.log([id, m.name ?? "", m.phone ?? "", m.messages, m.audios, stamp(m.generatedAt), convs].join("\t"));
  }
}

function questions(id) {
  const dir = caseDir(id);
  const threads = threadsOf(dir);
  const items = numberedQuestions(threads);
  if (!items.length) return console.log(`El contacto ${id} no tiene preguntas guardadas. Transcript: ${join(dir, `contact-${id}.txt`)}`);
  let current = 0;
  for (const it of items) {
    if (it.thread !== current) {
      current = it.thread;
      const t = threads[current - 1];
      console.log(`\n=== Conversación ${current} de ${threads.length} · creada ${stamp(t.createdAt)} · ${items.filter((x) => x.thread === current).length} preguntas`);
    }
    const a = it.answer;
    const answer = a ? `${a.error ? "[falló] " : ""}${clip(oneLine(a.text), 220)}${a.model ? ` — ${a.model}` : ""}` : "(sin respuesta)";
    console.log(`#${it.n} [${stamp(it.question.at)}] ${oneLine(it.question.text)}\n   → ${answer}`);
  }
  console.log(`\nArchivos: ${dir}`);
}

function qa(id, sel) {
  const items = numberedQuestions(threadsOf(caseDir(id)));
  const picked = parseSelection(sel, items.length);
  for (const it of items.filter((x) => picked.has(x.n))) {
    console.log(`\n===== #${it.n} · conversación ${it.thread} · ${stamp(it.question.at)}`);
    console.log(`PREGUNTA: ${it.question.text}`);
    const a = it.answer;
    if (!a) console.log("(sin respuesta)");
    else console.log(`RESPUESTA${a.error ? " (falló)" : ""}${a.model ? ` — ${a.model}` : ""} · ${stamp(a.at)}:\n${a.text}`);
  }
}

function stats(id) {
  const dir = caseDir(id);
  const all = readJson(join(dir, `contact-${id}.messages.json`)).filter((m) => m.role !== "internal").sort((a, b) => a.at - b.at);
  const side = (m) => (m.role === "client" ? "client" : "team");
  const meta = readJson(join(dir, `contact-${id}.meta.json`));
  const client = meta.name || "Cliente";
  console.log(`${client} (contacto ${id}): ${all.length} mensajes · cliente ${all.filter((m) => side(m) === "client").length} · equipo ${all.filter((m) => side(m) === "team").length}`);
  console.log(`Desde ${stamp(all[0].at * 1000)} hasta ${stamp(all.at(-1).at * 1000)} (hora de Colombia)`);
  for (const [from, to, label] of [["client", "team", `${client} esperando al equipo`], ["team", "client", `El equipo esperando a ${client}`]]) {
    const waits = [];
    let start = null;
    for (const m of all) {
      if (side(m) === from && start === null) start = m;
      else if (side(m) === to && start !== null) {
        waits.push({ start, end: m, seconds: m.at - start.at });
        start = null;
      }
    }
    const sorted = waits.map((w) => w.seconds).sort((a, b) => a - b);
    const median = sorted.length ? duration(sorted[Math.floor(sorted.length / 2)]) : "—";
    const long = waits.filter((w) => w.seconds > 86400);
    console.log(`\n${label}: ${waits.length} esperas · mediana ${median} · ${long.length} de más de 24 h`);
    for (const w of long) {
      console.log(`  ${stamp(w.start.at * 1000)} → ${stamp(w.end.at * 1000)} (${duration(w.seconds)}): ${clip(oneLine(w.start.text), 90)}`);
    }
  }
  console.log("\nUna espera empieza con el primer mensaje sin respuesta de un lado y termina con la respuesta del otro;");
  console.log("un «Ok» o un mensaje automático también la abren, así que revise el contexto antes de concluir.");
}

const [cmd, idArg, sel] = pos;
switch (cmd) {
  case "list":
    list();
    break;
  case "pull": {
    const dir = pull(contactId(idArg));
    console.log(`Listo: ${dir}`);
    break;
  }
  case "questions":
    questions(contactId(idArg));
    break;
  case "qa":
    qa(contactId(idArg), sel);
    break;
  case "stats":
    stats(contactId(idArg));
    break;
  default:
    fail("Uso: node scripts/case.mjs list | pull <id> [--out <dir>] | questions <id> | qa <id> <n|n-m|n,m> | stats <id>   [--refresh]");
}
