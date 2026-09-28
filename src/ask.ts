import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolveContactId } from "./chatwoot.js";
import { historyPath } from "./config.js";
import { answerText, type PreviousTurn } from "./llm.js";
import { buildHistory } from "./history.js";

const USAGE =
  'Uso: npm run ask -- <contact_id | +telefono | conv:N> ["<pregunta>"] [--refresh]\n' +
  "  Sin pregunta abre una sesión interactiva (las preguntas de seguimiento mantienen el contexto).\n" +
  "  --refresh vuelve a descargar el historial de Chatwoot antes de preguntar.";

async function loadTranscript(contactId: number, refresh: boolean): Promise<string> {
  const path = historyPath(contactId);
  const existing = await stat(path).catch(() => null);

  if (refresh || !existing) {
    console.log(existing ? "Actualizando historial..." : `No hay historial local para ${contactId}, generándolo...`);
    const { failedAudios, pendingAudios, quotaMessage } = await buildHistory(contactId);
    if (failedAudios + pendingAudios > 0) {
      console.warn(`  Aviso: ${failedAudios + pendingAudios} nota(s) de voz sin transcribir.` + (quotaMessage ? ` ${quotaMessage}` : ""));
    }
  } else {
    const hours = (Date.now() - existing.mtimeMs) / 3_600_000;
    if (hours >= 24) {
      console.log(`(Historial generado hace ${Math.floor(hours / 24)} día(s); use --refresh para actualizarlo.)`);
    }
  }
  return readFile(path, "utf-8");
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const [contactArg, ...questionParts] = args.filter((a) => a !== "--refresh");
  if (!contactArg) {
    console.error(USAGE);
    process.exit(1);
  }

  const contactId = await resolveContactId(contactArg);
  const transcript = await loadTranscript(contactId, refresh);
  const previous: PreviousTurn[] = []; // preguntas y respuestas de esta sesión, para las de seguimiento
  const ask = async (q: string) => {
    const { text, model } = await answerText(transcript, previous, q, (r) =>
      console.warn(`  (${r.failed} falló: ${r.reason}; se responde con ${r.next})`),
    );
    previous.push({ role: "user", text: q }, { role: "model", text });
    return `${text}\n\n  — ${model}`;
  };

  const question = questionParts.join(" ").trim();
  if (question) {
    console.log(await ask(question));
    return;
  }

  // Iterar el readline (en vez de rl.question en loop) no pierde líneas si la entrada llega por pipe.
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\n> " });
  console.log('Pregunte sobre el historial. Línea vacía o "salir" para terminar.');
  rl.prompt();
  for await (const line of rl) {
    const q = line.trim();
    if (!q || q.toLowerCase() === "salir") break;
    try {
      console.log(`\n${await ask(q)}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
