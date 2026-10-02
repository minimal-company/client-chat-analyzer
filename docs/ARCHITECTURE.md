# Arquitectura

El analizador reconstruye el historial completo de WhatsApp de un cliente, transcribe sus notas de voz y
deja hacerle preguntas a una IA sobre ese historial. Es un solo proceso de Node 20 (TypeScript, ESM) sin
base de datos: todo el estado vive en archivos dentro de `data/`.

```
                 ┌────────────── fuentes del historial ──────────────┐
 Chatwoot 4.0.3 (API) ─┐                                              │
 Evolution API ────────┼─► history.ts ─► data/contact-<id>.txt          (transcript que lee la IA)
 Exportación del       │    │           data/contact-<id>.messages.json (panel de chats)
 teléfono (_chat.txt) ─┘    │           data/contact-<id>.meta.json     (resumen y métricas)
                            └─► gemini.ts (lotes) / live.ts (Live API) ─► data/transcriptions/ (caché)

 Navegador ─► server.ts ─► auth.ts (usuarios, sesiones)          data/users.json, sessions.json
                 │     ├─► llm.ts ─► providers.ts ─► Gemini / OpenAI / Anthropic / compatibles
                 │     │     └─► quota.ts                         data/gemini-usage.json
                 │     ├─► qa-store.ts                            data/qa/contact-<id>.json
                 │     └─► panel.ts ─► settings.ts                data/settings.json, secrets.json
 CLI (./cca) ─► ask.ts · build-history.ts · user.ts  (mismo código y mismo data/)
```

## Módulos (`src/`)

| Archivo | Responsabilidad |
|---|---|
| `server.ts` | Servidor HTTP (`node:http`): páginas, archivos estáticos, API JSON, respuestas en streaming de las preguntas, cabeceras de seguridad (CSP con nonce por respuesta, HSTS por HTTPS). |
| `auth.ts` | Usuarios (scrypt), sesiones (solo el hash del token), roles administrador/analista, bloqueo por intentos fallidos, registro de ingresos. |
| `user.ts` | CLI de usuarios: `./cca user list \| add \| reset \| remove`. |
| `panel.ts` | API del Panel de control (`/api/panel/*`, solo administradores): proveedores y claves de IA, cadena de respaldo, límites, instrucciones, Chatwoot, Evolution, usuarios y sesiones. |
| `settings.ts` | Configuración editable desde el panel (`data/settings.json`) y claves cifradas con AES-256-GCM (`data/secrets.json`, llave derivada de `SETTINGS_SECRET`). Lo que no esté ahí sale de `.env`. |
| `config.ts`, `env.ts` | Configuración efectiva (panel → `.env` → valores por defecto), rutas de `data/`, `TIMEZONE`. |
| `chatwoot.ts` | Cliente de la API de Chatwoot: contactos, búsqueda, conversaciones, mensajes paginados, adjuntos, no leídos, creación de contactos. |
| `evolution.ts` | Segunda fuente: mensajes que llegaron a WhatsApp (Evolution API) pero nunca a Chatwoot, y descarga de sus archivos. |
| `whatsapp-export.ts`, `import-zip.ts` | Tercera fuente: el zip de "Exportar chat" del teléfono (se guarda solo `_chat.txt` y las notas de voz), su lectura y el cruce con lo que ya se tiene. |
| `history.ts` | Arma el historial: une las tres fuentes, elimina duplicados, ordena, transcribe las notas de voz y escribe los tres archivos del contacto. También resuelve de dónde reproducir cada audio. |
| `metrics.ts` | Métricas de atención calculadas en código (tiempos de respuesta, esperas largas): se entregan hechas a la IA, que no hace bien aritmética de fechas. |
| `gemini.ts`, `live.ts` | Transcripción de notas de voz: por lotes (varios audios por request) y, como respaldo, por la Live API (una sesión por audio, convertido a PCM con ffmpeg). |
| `llm.ts` | Preguntas: arma las instrucciones del analista más el transcript, recorre la cadena de modelos con tiempos máximos y respaldo, y devuelve la respuesta en fragmentos. |
| `providers.ts` | Adaptadores de IA para el chat: Gemini (SDK de Google), API compatible con OpenAI (OpenAI, DeepSeek, OpenRouter y propios) y Anthropic. |
| `quota.ts` | Presupuesto propio por modelo y por día de cuota de Google (requests por día y por minuto). |
| `qa-store.ts` | Conversaciones con la IA por cliente, con escritura atómica y un bloqueo por cliente. |
| `retry.ts` | Reintentos con espera para Chatwoot y Gemini. |
| `ask.ts`, `build-history.ts` | CLI: preguntar y generar historiales desde la terminal. |
| `types.ts` | Tipos de la API de Chatwoot. |

La interfaz son tres páginas estáticas con CSS y JS en línea: `public/index.html` (clientes, historial de
chats, conversación con la IA, métricas), `public/login.html` y `public/panel.html`. `marked` (servido en
`/vendor/marked.js`) convierte a HTML las respuestas en Markdown.

## Construcción del historial

`POST /api/history/:id/build` (o `./cca build-history <id>`) lanza un trabajo en segundo plano; la
interfaz consulta su avance con `GET` a la misma ruta.

1. **Chatwoot:** todas las conversaciones del contacto y todos sus mensajes. En la versión 4.0.3 el listado
   de conversaciones corta en 20; pasado ese tope se recorren las de la cuenta y se filtran por contacto.
2. **Evolution:** los mensajes del mismo número que Chatwoot no tiene (se cruzan por el id de WhatsApp,
   `WAID`). Se marcan `[solo en WhatsApp]`.
3. **Exportación del teléfono:** si existe `data/exports/contact-<id>/`, se agrega solo lo que falta: los
   audios se emparejan por tamaño exacto en bytes y el texto por contenido y hora. Si el chat no está en
   Chatwoot (menos de 3 coincidencias), se usa completo con el remitente que el usuario eligió como cliente
   (`meta.json` de la exportación) y la hora del teléfono en la zona configurada.
4. **Notas de voz:** se transcriben las que no están en `data/transcriptions/`, primero por lotes y lo que
   falle por la Live API (estrategia configurable). Sin cuota, quedan como `[sin transcribir]`.
5. **Salida:** `contact-<id>.txt` (encabezado con métricas + una línea por mensaje),
   `contact-<id>.messages.json` y `contact-<id>.meta.json`.

La interfaz vuelve a generar el historial sola si tiene más de 30 minutos al abrir el cliente.

## Preguntas a la IA

`POST /api/ask` responde en streaming. Por cada pregunta, `llm.ts` arma:

- **Instrucciones de sistema:** las instrucciones base del analista + las del negocio (Panel ›
  Instrucciones) + el transcript completo.
- **Memoria:** todos los pares pregunta/respuesta exitosos anteriores de esa conversación
  (`data/qa/contact-<id>.json`). Se reenvía completa en cada pregunta.
- **Modelo:** el primero disponible de la cadena de respaldo (familias `@flash` y `@flash-lite` incluidas).
  Si uno falla, tarda demasiado en empezar o se queda sin cuota, se pasa al siguiente sin esperar y el que
  falló queda al final de la fila unos minutos.

Costo en tokens: cada pregunta envía el transcript más toda la memoria de la conversación. En el caso del
contacto 9 eso llegó a ~206 mil tokens por pregunta (62 mil de transcript y 142 mil de memoria), lo que
agota los límites por minuto del tier gratuito; y cada modelo de respaldo recibe la misma carga. Empezar una
conversación nueva por tema lo reduce; limitar la memoria enviada es la mejora pendiente.

## Almacenamiento (`data/`)

| Ruta | Contenido |
|---|---|
| `contact-<id>.txt`, `.messages.json`, `.meta.json` | Historial de cada cliente (ver arriba). |
| `qa/contact-<id>.json` | `{ threads: [{ id, createdAt, messages: [{ role: user\|model\|event, text, at, model?, error?, notes? }] }] }` |
| `exports/contact-<id>/` | `_chat.txt`, notas de voz y `meta.json` (`clientSender`) de la exportación del teléfono. |
| `transcriptions/` | Caché de transcripciones de notas de voz. |
| `users.json`, `sessions.json`, `auth-log.json` | Usuarios, sesiones y registro de ingresos. |
| `settings.json`, `secrets.json` | Configuración del Panel de control y claves cifradas. |
| `gemini-usage.json` | Uso diario por modelo. |
| `tmp/` | Zips subidos mientras se procesan. |

Todo `data/` queda fuera de git y de la imagen Docker. Respaldarlo es respaldar todo el sistema (con
`SETTINGS_SECRET`, sin el cual las claves de `secrets.json` no se pueden leer).

## API

Sin sesión: `GET /healthz`, `/login`, `/assets/*`, `POST /api/login`, `POST /api/logout`. Con sesión:

| Ruta | Uso |
|---|---|
| `GET /api/me`, `POST /api/password` | Usuario actual y cambio de contraseña. |
| `GET /api/histories` | Clientes con historial (metas). |
| `GET /api/contacts?q=`, `GET /api/contacts/all?page=`, `POST /api/contacts` | Búsqueda, listado con no leídos y creación de contactos en Chatwoot. |
| `GET /api/history/:id` | Meta + transcript + trabajo en curso. |
| `POST\|GET /api/history/:id/build` | Generar/actualizar el historial y ver su avance. |
| `GET /api/history/:id/messages`, `/transcript`, `/audio?key=` | Mensajes para el panel, descarga del transcript y audios. |
| `POST /api/history/:id/import`, `/export-client` | Subir la exportación del teléfono y elegir quién es el cliente. |
| `GET /api/qa/:id`, `POST /api/qa/:id/threads` | Conversaciones con la IA. |
| `POST /api/ask` | Pregunta (respuesta en streaming). |
| `GET /api/threads`, `/api/models`, `/api/usage` | Todas las conversaciones, cadena de modelos y uso del día. |
| `/panel`, `/api/panel/*` | Panel de control (solo administradores). |

Mientras un usuario no cambie su contraseña inicial, el resto de la API responde 403. Todo pedido que
modifica algo debe venir del mismo sitio (cabecera `Origin`).

## Despliegue

`compose.yml` define el servicio `web` (siempre arriba, puerto 8790 en la LAN, healthcheck `/healthz`) y
`analyzer` (perfil `cli`, para `./cca`). Ambos montan `./data` y se unen a dos redes externas:

- `chatwoot-chatwoot-njyzd4`, la de Chatwoot en Dokploy (el contenedor rails responde como
  `chatwoot-rails:3000`); Traefik también está ahí y enruta `analizador.minimal-company.com` al servicio.
- `evolution-docker_default`, la de Evolution API (`evolution-api:8080`).

El dominio público (registro A solo DNS, que actualiza el servicio `ddns`) llega por el puerto 443 del
router hasta Traefik, que termina TLS con un certificado de Let's Encrypt (reto TLS-ALPN). Los pasos están
en la sección de publicación del README. La imagen (`Dockerfile`) compila TypeScript en una etapa y en la final instala
solo dependencias de producción y ffmpeg.

## Herramientas (`scripts/`)

- `case.mjs`: lee el caso de un cliente del servidor por SSH (transcript, mensajes, conversaciones con la
  IA) y lo muestra: preguntas numeradas, respuestas completas y tiempos de respuesta. Ver `CLAUDE.md`.
- `ui-mock.mjs`: sirve la interfaz real con los casos bajados, sin servidor, contraseñas ni IA, para
  revisar cambios visuales.
