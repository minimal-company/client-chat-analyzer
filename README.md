# Analizador de chats (client-chat-analyzer)

Extrae el historial completo (texto + notas de voz transcritas) de un contacto en Chatwoot,
lo consolida en un solo archivo de texto, y permite hacerle preguntas con Gemini.

Se usa desde el navegador (interfaz web) o desde la terminal (CLI); ambos comparten `data/`.

Documentación:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): módulos, flujo de datos, almacenamiento, API y despliegue.
- [CLAUDE.md](CLAUDE.md): instrucciones para Claude Code, incluido cómo leer los transcripts y las
  conversaciones con la IA de un cliente para analizarlos en otra sesión.

## Análisis de un caso desde la terminal (o con Claude Code)

`scripts/case.mjs` lee del servidor por SSH, sin modificar nada, el transcript y las conversaciones con la
IA de un cliente:

```bash
node scripts/case.mjs list              # clientes con historial y sus conversaciones
node scripts/case.mjs questions 9       # todas las preguntas hechas a la IA, numeradas
node scripts/case.mjs qa 9 104-106      # pregunta y respuesta completas
node scripts/case.mjs stats 9           # tiempos de respuesta de cada lado
```

`scripts/ui-mock.mjs` sirve la interfaz con esos casos, sin servidor ni contraseñas, para revisar cambios
visuales.

## Interfaz web (Docker)

```bash
docker compose up -d --build web      # queda corriendo, reinicia sola con el servidor
```

- **Por internet:** https://analizador.minimal-company.com (router, puerto 443 → Traefik de Dokploy →
  servicio `web`; certificado de Let's Encrypt). Sin Cloudflare de por medio, así que se pueden importar
  chats de cualquier tamaño (hasta 4 GB).
- **En la LAN:** `http://<ip-del-servidor>:8790` (http://192.168.1.36:8790).

Se entra con usuario y contraseña en una página propia (no la ventana del navegador). El primer
usuario sale de `WEB_USER` / `WEB_PASSWORD` en `.env` y debe cambiar la contraseña al ingresar; los
demás se administran en el servidor:

```bash
./cca user list
./cca user add maria "María Gómez"   # muestra una contraseña temporal; se cambia al ingresar
./cca user reset maria               # nueva contraseña temporal y cierra sus sesiones
./cca user remove maria
```

Cada quien cambia su contraseña desde el menú de su nombre (abajo a la izquierda), y eso cierra sus
demás sesiones. Hay dos roles: **administrador** (todo, incluido el Panel de control) y **analista**
(clientes y conversaciones con la IA). `./cca user add` crea analistas; `--admin`, administradores.

### Panel de control (`/panel`, solo administradores)

- **Modelos y API keys:** Gemini, OpenAI, Anthropic, DeepSeek, OpenRouter y cualquier proveedor
  compatible con OpenAI; clave, URL base, tiempo máximo sin respuesta y modelos de cada uno; la
  cadena de respaldo (el primero es el principal; "Todos los Gemini Flash" suma los nuevos solo) y el
  modelo de cada tarea. Las notas de voz solo se transcriben con Gemini.
- **Límites y cuotas, Instrucciones del analista** (contexto del negocio que se suma a cada pregunta),
  **Conexiones CRM** (Chatwoot), **WhatsApp** (Evolution), **Usuarios** y **Seguridad** (sesiones
  abiertas e ingresos recientes).

Lo que se guarda ahí va a `data/settings.json` y, las claves, cifradas con `SETTINGS_SECRET` en
`data/secrets.json`; mientras no se guarde nada, todo sale de `.env` como antes. "Probar conexión" solo
lista los modelos del proveedor: no gasta cuota.

- Busque al cliente por nombre, teléfono (`+57300…`), conversación (`conv:18`) o ID.
- La primera vez descarga todo su historial y transcribe las notas de voz (se ve el progreso).
- Después le hace preguntas en un chat; las de seguimiento recuerdan el contexto. Hay preguntas
  sugeridas: resumen, evaluación de la atención con nota, quién tiene razón en un reclamo, etc.
- "Métricas de atención" muestra tiempos de respuesta calculados por el sistema; "Ver transcript"
  muestra el historial completo con filtro; "Actualizar" lo vuelve a bajar de Chatwoot.
- El historial de chats (panel derecho) separa los mensajes por día y deja fija arriba la fecha del día
  que se está viendo. Las fechas que cita la IA en sus respuestas llevan a ese mensaje con un clic.

Seguridad:
- Contraseñas con scrypt en `data/users.json`; sesiones en `data/sessions.json` (solo el hash del
  token). La sesión vence a los 7 días sin uso y dura como máximo 30.
- Cookie `HttpOnly`, `SameSite=Lax` y `Secure` por HTTPS; todo pedido que modifica algo debe venir del
  mismo sitio (Origin), y por internet se fuerza HTTPS.
- 5 intentos fallidos desde una IP (o 10 contra un usuario) bloquean el ingreso 15 minutos.
- CSP estricta, HSTS, `X-Frame-Options: DENY` y demás cabeceras en todas las respuestas.
- En la LAN la conexión es HTTP plano: úsela solo en una red de confianza.
- Administradores y analistas ven todos los clientes y todas las conversaciones con la IA; solo el Panel
  de control está restringido a administradores.

Operación: `docker compose ps` muestra el estado de salud (`/healthz`); logs con
`docker compose logs -f web` (rotan: 5 × 10 MB); los ingresos y fallos quedan registrados con la IP.
Actualizar el código: copiar los archivos y repetir `up -d --build web`. Respalde `data/`: tiene los
historiales, las conversaciones con Gemini y los usuarios.

Publicación (sin túnel, directo a Traefik):

1. **Router:** reenviar TCP 443 (y UDP 443 para HTTP/3) a `192.168.1.36:443`, y reservar esa IP por DHCP
   para el servidor. El puerto 80 queda cerrado: por ahí Traefik atiende otros dominios (y el de Dokploy)
   que no deben quedar expuestos sin Cloudflare.
2. **DNS (Cloudflare):** `analizador` es un registro A, solo DNS (nube gris), a la IP pública de la casa.
   La IP puede cambiar, así que la mantiene el servicio `ddns` (`docker compose up -d ddns`, con
   `CLOUDFLARE_API_TOKEN` en `.env`: token con permiso Zone › DNS › Edit solo para minimal-company.com).
3. **Traefik de Dokploy** (`/etc/dokploy/traefik/traefik.yml`, requiere sudo o el editor de Traefik de
   Dokploy): el resolvedor `letsencrypt` usa `tlsChallenge: {}` en lugar de `httpChallenge` (el puerto 80
   no está abierto), con un correo real, y la entrada `websecure` tiene
   `transport.respondingTimeouts.readTimeout: 30m` (por defecto corta a los 60 s las subidas de chats
   grandes). Después: `docker restart dokploy-traefik`.
4. Las etiquetas de Traefik del servicio `web` están en `compose.yml` (router en `websecure` con
   `tls.certresolver=letsencrypt`).

## Exportación del chat desde el teléfono (tercera fuente)

Cuando faltan mensajes o notas de voz que WhatsApp ya no sirve (vencen a las pocas semanas), exporte
el chat desde el teléfono (WhatsApp → chat → ⋮ → Más → Exportar chat → Incluir archivos) y deje en el
servidor el `_chat.txt` y las notas de voz:

```bash
mkdir -p data/exports/contact-<contact_id>
unzip -j "WhatsApp Chat - Cliente.zip" "_chat.txt" "*.opus" -d data/exports/contact-<contact_id>
```

En cada actualización se cruza con Chatwoot + Evolution y **solo se usa lo que falta**: los archivos se
emparejan por tamaño exacto en bytes (se conserva de punta a punta) y el texto por contenido y hora. La
zona horaria del teléfono se detecta sola. Lo agregado figura como `[solo en WhatsApp]`.

## CLI (Docker)

```bash
./cca build-history conv:18
./cca ask conv:18 "¿qué pidió el cliente?"
./cca ask conv:18            # sesión interactiva
```

## Setup

Requiere Node.js 20 o superior.

```bash
npm install
cp .env.example .env
# completa CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN y GEMINI_API_KEY
```

El `CHATWOOT_API_TOKEN` es el token de acceso de un usuario (Perfil > Configuración de acceso a la
API en Chatwoot), no el de un inbox ni el de un Agent Bot. Use el de un **administrador**: Chatwoot
solo le muestra a un agente común las conversaciones de los inboxes a los que pertenece.

## Uso

El contacto se indica con su `contact_id` de Chatwoot o con su teléfono **con `+`**
(`+573001234567`). Sin el `+`, un número se interpreta como `contact_id`.

**1. Construir el historial:**

```bash
npm run build-history -- <contact_id | +telefono> [otro contacto ...]
```

Recorre todas las conversaciones del contacto, pagina todos los mensajes de cada una, transcribe
cada nota de voz con Gemini y guarda todo en orden cronológico en `data/contact-<contact_id>.txt`.

Las notas de voz se transcriben **en lotes** (hasta 30 audios / 4 MB por request) y se cachean en
`data/transcriptions/`: volver a correrlo solo envía los audios que falten. Si alguno no se pudo
transcribir (error o cuota agotada), el historial se escribe igual con `(nota de voz) [sin transcribir]`
y el comando termina con código 2.

**2. Preguntar sobre ese historial:**

```bash
npm run ask -- <contact_id | +telefono> "¿el cliente ya confirmó su dirección de envío?"
npm run ask -- <contact_id | +telefono>              # sesión interactiva
npm run ask -- <contact_id | +telefono> --refresh    # actualiza el historial antes de preguntar
```

En la sesión interactiva las preguntas de seguimiento conservan el contexto ("¿y cuándo dijo
eso?"). Si no existe el historial local, `ask` lo genera primero; si tiene más de un día, avisa.

## Formato del transcript

```
[2026-09-01 14:03] Cliente: hola, sigue disponible el depto?
[2026-09-01 14:05] Bot: ¡Hola! Sí, ...
[2026-09-01 14:20] Cliente: (nota de voz) quería saber si aceptan mascotas
[2026-09-01 15:02] Nota interna (Ana): ya pagó la seña por transferencia
[2026-09-01 15:10] Agente (Steven): [imagen] Te paso el contrato
```

- Las horas se muestran en `TIMEZONE` (por defecto `America/Bogota`).
- Las **notas internas** se incluyen, marcadas como tales: dan contexto útil, y a Gemini se le indica
  que el cliente nunca las vio.
- Los mensajes de un Agent Bot figuran como `Bot`. Un bot que publica usando el token de un usuario
  aparece como ese usuario (`Agente (nombre)`).
- Los adjuntos que no son audio aparecen como marcadores (`[imagen]`, `[archivo .pdf]`,
  `[ubicación: ...]`) junto con su texto, si lo tienen; su contenido no se analiza.
- Si Chatwoot ya transcribió un audio (su propia función de transcripción), se usa ese texto y no se
  llama a Gemini.

## Notas de diseño

- **Sin RAG / vector DB.** El transcript completo de un cliente cabe cómodo en la ventana de
  contexto de Gemini, así que se manda entero. Va en el system instruction, idéntico en cada turno,
  y Gemini lo cachea implícitamente como prefijo, así que las preguntas siguientes salen más baratas.
- **Muchas conversaciones.** El listado de conversaciones de un contacto corta en 20 (Chatwoot 4.x) o
  25 (versiones nuevas) y no se puede paginar. Pasado ese tope, en versiones nuevas se recorre la
  cadena con `?conversation_id=`; en 4.x se recorren todas las conversaciones de la cuenta y se
  filtran por contacto.
- **Adjuntos.** Se descargan de `data_url` (URL firmada, no requiere auth) *sin* el token de
  Chatwoot, para no filtrarlo al storage externo al que redirige. Esa URL la arma Chatwoot con su
  `FRONTEND_URL`: la máquina donde corre esto tiene que poder alcanzarla.
- **Reintentos.** Los 429/5xx de Chatwoot y Gemini se reintentan con backoff, respetando el
  `retryDelay` que devuelve Gemini. Una cuota *diaria* agotada no se reintenta.
  Ver también "Cuota de Gemini" más abajo.
- **Modelo.** `gemini-flash-latest` es un alias que Google mueve al Flash más nuevo, y el más nuevo
  suele ser el más saturado (503 "high demand") y el de menor cuota gratuita. Conviene fijar un modelo
  concreto en `.env` para que la cuota sea predecible.

## Cuota de Gemini

Google limita por modelo: requests por minuto (RPM) y por día (RPD). En el tier gratuito, los Flash
nuevos permiten **20 requests por día**. El día de cuota termina a medianoche del Pacífico (02:00 en
Colombia; 03:00 cuando en EE. UU. no rige el horario de verano). Lo que cuenta es el request, no su tamaño: por eso las notas de voz van en lotes.

El analizador lleva su propio presupuesto en `data/gemini-usage.json` (lo comparten la web y la CLI):

- Antes de cada request verifica `GEMINI_DAILY_LIMIT` (20) y espacia según `GEMINI_RPM` (5/min).
  Si no hay presupuesto, **no llama a Gemini** y lo informa.
- La transcripción deja libres los últimos `GEMINI_QA_RESERVE` (5) requests del día para preguntas.
- Si Google responde "cuota diaria agotada", el modelo queda bloqueado hasta el reset: ningún audio ni
  pregunta más se envía ese día. Dos lotes seguidos fallando (p. ej. 503) también cortan la corrida.
- Cada reintento cuenta como request; por eso Gemini se reintenta como máximo 2 veces.
- La barra lateral de la web muestra el uso del día.

### Respaldo por Live API

Con `GEMINI_TRANSCRIBE_LIVE_MODEL` (p. ej. `gemini-3.5-transcribe-live`), lo que los lotes no
resuelvan se transcribe por la Live API: una sesión WebSocket por nota de voz (el audio se convierte a
PCM con ffmpeg, incluido en la imagen Docker), ~10 s por nota, varias en paralelo. No tiene cuota
diaria pero sí por minuto: `GEMINI_LIVE_RPM` (10) espacia las sesiones y, si Google igual corta por
cuota, todas esperan 60 s y se reintenta. `GEMINI_TRANSCRIBE_STRATEGY=live` saltea los lotes.

Probado el 22/09: `gemini-3.5-transcribe` devuelve respuestas vacías con lotes de varios audios, así
que en el servidor está configurado `live` (222 notas en ~15 min).

Costo típico con el tier gratuito: 222 notas de voz ≈ 8 requests; cada pregunta = 1 request (las de
seguimiento también: reenvían el transcript completo). Con tier pago, suba `GEMINI_DAILY_LIMIT` y
`GEMINI_RPM` a los límites de tu proyecto.
