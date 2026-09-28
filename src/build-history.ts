import { resolveContactId } from "./chatwoot.js";
import { buildHistory } from "./history.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Uso: npm run build-history -- <contact_id | +telefono | conv:N> [...]");
    process.exit(1);
  }

  let anyFailedAudio = false;
  for (const arg of args) {
    const contactId = await resolveContactId(arg);
    const { path, messages, failedAudios, pendingAudios, quotaMessage } = await buildHistory(contactId);
    console.log(`Historial consolidado en ${path} (${messages} mensajes).`);
    if (failedAudios + pendingAudios > 0) {
      anyFailedAudio = true;
      console.warn(
        `  ${failedAudios + pendingAudios} nota(s) de voz figuran como [sin transcribir]` +
          (quotaMessage ? ` (${quotaMessage})` : "") +
          ". Vuelva a correr el comando más tarde: solo se envían esas (el resto está en caché).",
      );
    }
  }
  if (anyFailedAudio) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
