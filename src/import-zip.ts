import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, rename } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { DATA_DIR } from "./config.js";
import { exportDir } from "./whatsapp-export.js";

// Importación de la exportación de WhatsApp desde la interfaz ("Importar chat"). El zip puede pesar
// cientos de MB (videos incluidos): se recibe a disco en streaming y de adentro se extraen solo el
// _chat.txt y las notas de voz, que es lo único que usa el analizador.

const MAX_ZIP_BYTES = 4 * 1024 ** 3;
const AUDIO = /\.(opus|ogg|oga|m4a|mp3|aac|amr|wav)$/i;

async function receive(req: IncomingMessage, target: string): Promise<number> {
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_ZIP_BYTES) req.destroy(new Error("El archivo supera los 4 GB"));
  });
  await pipeline(req, createWriteStream(target));
  return bytes;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((ok, fail) => yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => (err ? fail(err) : ok(zip!))));
}

/** Extrae _chat.txt y los audios (por nombre base: un zip no puede escribir fuera de la carpeta). */
async function extract(zipPath: string, dir: string): Promise<{ chat: boolean; audios: number }> {
  const zip = await openZip(zipPath);
  let chat = false;
  let audios = 0;
  await new Promise<void>((done, fail) => {
    zip.on("error", fail);
    zip.on("end", done);
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = basename(entry.fileName);
      const wanted = name === "_chat.txt" || AUDIO.test(name);
      if (!wanted || entry.fileName.endsWith("/")) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return fail(err ?? new Error("No se pudo leer el zip"));
        pipeline(stream, createWriteStream(resolve(dir, name)))
          .then(() => {
            if (name === "_chat.txt") chat = true;
            else audios++;
            zip.readEntry();
          })
          .catch(fail);
      });
    });
    zip.readEntry();
  });
  return { chat, audios };
}

/**
 * Recibe el zip del pedido, lo valida y reemplaza la exportación guardada del contacto. Si el zip no
 * trae _chat.txt, no toca la exportación anterior.
 */
export async function importWhatsAppZip(contactId: number, req: IncomingMessage): Promise<{ audios: number; megabytes: number }> {
  const tmpDir = resolve(DATA_DIR, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const stamp = `${contactId}-${Date.now()}`;
  const zipPath = resolve(tmpDir, `import-${stamp}.zip`);
  const staging = resolve(tmpDir, `export-${stamp}`);
  try {
    const bytes = await receive(req, zipPath);
    await mkdir(staging, { recursive: true });
    const { chat, audios } = await extract(zipPath, staging).catch(() => {
      throw new Error("El archivo no es un zip válido de WhatsApp");
    });
    if (!chat) throw new Error("El zip no trae _chat.txt: use WhatsApp → Exportar chat → Incluir archivos");
    const target = exportDir(contactId);
    // Quién es el cliente (si se eligió al importar antes) vale también para el chat nuevo.
    await copyFile(resolve(target, "meta.json"), resolve(staging, "meta.json")).catch(() => {});
    await rm(target, { recursive: true, force: true });
    await mkdir(resolve(target, ".."), { recursive: true });
    await rename(staging, target);
    return { audios, megabytes: Math.round(bytes / 1024 ** 2) };
  } finally {
    await rm(zipPath, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}
