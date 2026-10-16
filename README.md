# WA Sender

Send personalised WhatsApp messages to members of your groups, 5–10 people at a time, from your phone or laptop.

- One or more WhatsApp numbers, connected 24/7 through [OpenWA](https://github.com/rmyndharis/OpenWA) (unofficial gateway, Baileys engine). Link extra numbers under More → WhatsApp connection, then pick "Send from" on any group or list. Nobody gets the same template twice, whichever number sent it.
- Pick a group → pick a template → tick people → send. Messages go out one by one with a random 45–120 s gap.
- **Never the same template twice to the same person** (enforced by the database).
- Hide numbers you never want to message, across all groups.
- Delivery / read ticks in History.
- Installable on Android as a Chrome app (PWA).

> ⚠️ Unofficial WhatsApp connection: use a number you can afford to lose, and keep volumes small.

## Run locally

Needs Docker (on macOS: `brew install colima docker docker-compose && colima start`).

```bash
cp .env.example .env      # then fill in the secrets (openssl rand -hex 24)
docker compose up -d --build
```

Open http://localhost:3000, log in with `APP_PASSWORD` from `.env`, then **More → WhatsApp connection** and scan the QR code with WhatsApp → Linked devices.

From your phone on the same Wi-Fi: `http://<your-computer-ip>:3000`. From anywhere: install Tailscale on both and use the computer's Tailscale address.

## Deploy (automatic)

Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml): type-check + build, then upload to the Google Cloud VM (`wa-sender`, us-central1-a, e2-micro) and restart with `docker-compose.prod.yml` (adds Caddy for HTTPS). Live at https://34-56-155-51.sslip.io.

The server's `/opt/wa-sender/.env` holds the real secrets and is never overwritten by deploys. To change a setting there:

```bash
gcloud compute ssh wa-sender --zone=us-central1-a --command='sudo nano /opt/wa-sender/.env'
```

Then re-run the Deploy workflow (Actions → Deploy → Run workflow).

Only one copy of the app may be connected to WhatsApp at a time, so keep the local stack stopped (`docker compose stop`) while the server is live.

## Layout

| Path | What |
|---|---|
| `server/` | Fastify API + send queue, SQLite (`node:sqlite`), runs TypeScript directly on Node 24 |
| `web/` | React + Vite + Tailwind PWA |
| `docker-compose.yml` | `openwa` (gateway) + `wa-app` (this app) |

Data lives in two Docker volumes: `openwa-data` (WhatsApp login) and `app-data` (templates, history, hidden numbers). Back both up before moving servers.

## Develop

```bash
docker compose up -d openwa                 # gateway only
cd server && npm install && OPENWA_URL=http://localhost:2785 npm run dev
cd web && npm install && npm run dev        # http://localhost:5173
```

## Settings (`.env`)

| Key | Default | Meaning |
|---|---|---|
| `MIN_DELAY_SEC` / `MAX_DELAY_SEC` | 45 / 120 | Random gap between two messages |
| `DAILY_CAP` | 40 | Max messages per day, per number; the rest wait for tomorrow |
| `MAX_BATCH` | 10 | Max people per send |

OpenWA also enforces its own warm-up limits for new numbers and first-time chats (`SEND_PACING_ENABLED`). When it says "slow down", messages simply stay queued and retry later.
