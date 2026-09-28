# Client chat analyzer: notes for Claude Code

Web app and CLI for Minimal Company (Steven Mancilla). It rebuilds a client's full WhatsApp history from
three sources (Chatwoot, Evolution API and the phone's chat export), transcribes the voice notes with
Gemini, and lets the team ask an AI analyst questions about each client. The UI is in Colombian Spanish
(usted, no voseo) and every date is in America/Bogota.

- Architecture, modules and data flow: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Operation and user-facing docs (Spanish): [README.md](README.md)

## Answering questions about a client (transcripts and agent conversations)

Client data lives on the production box, never in this repo. Read it with `scripts/case.mjs` (Node 20,
no dependencies). It only reads over SSH and never writes to the server:

```bash
node scripts/case.mjs list                 # clients with a history, and their saved agent conversations
node scripts/case.mjs questions 9          # every question asked to the in-app agent, numbered, with date and model
node scripts/case.mjs qa 9 104-106         # full question and answer for those numbers (also 3,7 or 12)
node scripts/case.mjs stats 9              # reply times on each side and every wait over 24 h
node scripts/case.mjs pull 9 --out <dir>   # only copy the files (the commands above do it on first use)
```

Files go to `<OS temp>/cca-cases/<id>/`, or to `--out` / `CCA_CASES_DIR` (prefer the session scratchpad).
`--refresh` downloads them again: the server regenerates a history whenever someone presses
"Actualizar" in the app. Then Read and Grep the local files directly:

| File | Content |
|---|---|
| `contact-<id>.txt` | The transcript the in-app agent reads: a header, then one line per message, e.g. `[2026-08-05 11:06] Cliente: …`, `Agente (steven): …`, `Bot: …`, `Nota interna (Ana): …` |
| `contact-<id>.messages.json` | The same messages as JSON: `at` (epoch seconds), `role` (`client`, `agent`, `bot`, `internal`), `name`, `text`, `kind`, `onlyWhatsApp` |
| `contact-<id>.meta.json` | Name, phone, counts, response metrics, `generatedAt` |
| `qa.json` | Conversations with the in-app agent: `threads[].messages[]` with `role` (`user`, `model`, `event`), `text`, `at` (epoch ms), `model`, `error` |

Reading a transcript:
- `(nota de voz) …` is Gemini's transcription of a voice note: close, but not verbatim. Typed text is exact.
- `[solo en WhatsApp]` marks messages that reached WhatsApp but never Chatwoot (recovered from Evolution or
  from the phone export), so the team may not have seen them in Chatwoot.
- Timestamps are Bogotá time to the minute. Cite them as `[2026-08-05 11:06]`. In the app, clicking a date
  inside an answer jumps to that message.
- `Agente (<name>)` lines are the business side. In contact 9 (Richar Gamboa), `Agente (steven)` is the user.

How to analyze (lessons from earlier sessions):
- Check every claim against the transcript and cite it. The in-app agent's answers are not evidence: it was
  often sycophantic and sometimes invented facts (a "$1.000 KPI" that appears nowhere in the chat). When the
  user quotes the agent, verify it before building on it.
- Be balanced and direct: separate what the chat shows, your interpretation, and what can't be known; give
  the other party's strongest argument; no personality diagnoses; no false certainty about legal outcomes.
- Don't use the app's AI (or any AI API) to do the analysis: it spends the user's Gemini quota. Read the
  files and analyze them yourself.
- Reply in the user's language (English in chat) and quote Spanish messages verbatim.

Privacy:
- Keep client files in the scratchpad or temp dir, never in the repo (`data/` and `.cases/` are git-ignored).
- Transcripts can contain passwords, verification codes, ID and bank numbers: don't repeat them unless the
  user asks for that exact value, and never send transcripts to another service.
- Don't read or print the server's `.env`, `users.json`, `sessions.json`, `settings.json` or `secrets.json`
  unless the task requires it.

## Production box

- `vaioserver@192.168.1.36` (Ubuntu, Docker, Dokploy + Traefik). The SSH key isn't in `~/.ssh/config`, so
  always pass it: `ssh -i ~/.ssh/vaioserver_ed25519 -o BatchMode=yes vaioserver@192.168.1.36 "…"`. Without
  `-i`, ssh falls back to a password and fails.
- App folder `~/client-chat-analyzer`: a copy of this repo (not a git checkout) plus `.env` (chmod 600) and
  `data/`.
- Services in `compose.yml`: `web` (always on; port 8790 on the LAN; healthcheck `/healthz`) and `analyzer`
  (profile `cli`, run as `./cca ask | build-history | user …`). Both join the external networks
  `chatwoot-chatwoot-njyzd4` (Chatwoot rails answers as `chatwoot-rails:3000`; Traefik lives there too) and
  `evolution-docker_default` (`evolution-api:8080`).
- `https://analizador.minimal-company.com` goes Cloudflare tunnel → Traefik → `web`. It only works if the
  host's `/etc/cloudflared/config.yml` has the ingress rule. Anything that needs sudo on the box, the user runs.
- Chatwoot there is v4.0.3: `/contacts/:id/conversations` stops at 20 with no paging. Don't read the Chatwoot
  database directly; use its API.

Deploying a change:
1. Confirm the box differs from your local copy only by your change:
   `ssh … "cd ~/client-chat-analyzer && find src public -type f -exec sha256sum {} +"` and compare.
2. Copy only what changed (`scp`, or a tar of `src public package.json package-lock.json tsconfig.json
   Dockerfile compose.yml docker-entrypoint.sh`). Never ship `node_modules`, `.env` or `data/`.
3. `ssh … "cd ~/client-chat-analyzer && docker compose up -d --build web"`, then wait for `(healthy)` in
   `docker compose ps web`.
4. Commit and push, so GitHub keeps matching the box.

## Development

- `npm install`, then `npm run typecheck` (TypeScript, ESM, NodeNext). There is no test suite; checks are
  ad-hoc scripts and the UI mock.
- Visual checks without logging in: `node scripts/case.mjs pull 9`, then `node scripts/ui-mock.mjs` and open
  http://127.0.0.1:8798/#/c/9. It serves `public/` with the pulled case (no AI, no audio, no Control Panel).
  Never type real passwords into a browser.
- Don't send real requests to AI models just to test something: the free tier allows about 20 requests a day
  per Flash model. Use mocks.
- The UI is three static pages (`public/index.html`, `login.html`, `panel.html`) with inline CSS and JS. The
  server adds a per-response nonce to every `<script>` tag and the CSP blocks everything else, so inline
  handler attributes (`onclick="…"`) don't run: attach handlers from JS, as the existing code does.
- Copy is Colombian Spanish with usted; dates use `es-CO` and America/Bogota. Use the brand logo
  `public/assets/logo-minimal.png` unmodified.
