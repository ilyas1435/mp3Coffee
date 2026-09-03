# Deployment Guide — YouTube to MP3 Converter

This is a pnpm monorepo with two services that must both run:

| Service | Default port | Purpose |
|---|---|---|
| `artifacts/api-server` | `8080` | Express API + yt-dlp worker |
| `artifacts/yt-mp3` | any | React frontend (served as static files in production) |

---

## Prerequisites

Install the following on your host:

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | 20 or 22 LTS | `node --version` |
| **pnpm** | 9+ | `npm i -g pnpm` |
| **Python** | 3.10+ | Required to run yt-dlp |
| **yt-dlp** | latest | See below |
| **ffmpeg** | 6+ | Audio extraction & conversion |
| **PostgreSQL** | 14+ | Database for job history & settings |

### Install yt-dlp

```bash
# Linux / macOS
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
```

The API server also ships its own yt-dlp at `artifacts/api-server/bin/yt-dlp` and will auto-update it on startup. If you prefer to manage it yourself, remove or replace that file.

---

## 1 — Clone & install dependencies

```bash
git clone <your-repo-url> yt-mp3
cd yt-mp3
pnpm install
```

---

## 2 — Create the PostgreSQL database

```bash
createdb yt_mp3          # or use your preferred tool / hosted DB
```

---

## 3 — Set environment variables

Create a `.env` file in the **repo root** (pnpm will forward it to each workspace package):

```env
# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/yt_mp3

# ── Session secret (any long random string) ───────────────────────────────────
SESSION_SECRET=replace-with-a-long-random-string

# ── Optional: override the upload directory (default: artifacts/api-server/uploads) ──
# UPLOADS_DIR=/var/data/yt-mp3-uploads

# ── Optional: the port the API server listens on (default: 8080) ──────────────
# PORT=8080

# ── Optional: the port the Vite dev server listens on ─────────────────────────
# VITE_PORT=3000
```

**Important**: never commit `.env` to git. Add it to `.gitignore`.

---

## 4 — Push the database schema

```bash
pnpm --filter @workspace/db run push
```

This runs `drizzle-kit push` and creates all tables. Re-run it after any schema update.

---

## 5 — Build all packages

```bash
pnpm run build
```

This compiles the shared libraries (`lib/db`, `lib/api-zod`, etc.) and the API server.

---

## 6 — Build the frontend (production static files)

```bash
pnpm --filter @workspace/yt-mp3 run build
```

The compiled frontend lands in `artifacts/yt-mp3/dist/`.

---

## 7 — Serve in production

### Option A — Serve frontend via the API server (simplest)

Add this to `artifacts/api-server/src/app.ts` (or configure nginx/caddy to proxy):

The API server already serves the frontend's `dist/` folder when `NODE_ENV=production`. Set:

```env
NODE_ENV=production
```

Then start the API server — it will serve both the API at `/api/…` and the React SPA at `/`:

```bash
NODE_ENV=production node artifacts/api-server/dist/index.mjs
```

### Option B — nginx + separate Node process (recommended for production)

**nginx config** (`/etc/nginx/sites-available/yt-mp3`):

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Serve React static files
    root /path/to/yt-mp3/artifacts/yt-mp3/dist;
    index index.html;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API calls to Node
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # Allow large uploads (cookies file, etc.)
        client_max_body_size 50M;
        # Conversions can take several minutes — don't timeout
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

Enable it and restart nginx:

```bash
sudo ln -s /etc/nginx/sites-available/yt-mp3 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Start the API server as a background service (see systemd below).

### Option C — Docker (optional)

A minimal `Dockerfile` for the API server:

```dockerfile
FROM node:22-slim

# Install system deps
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp \
    && apt-get clean

# Install pnpm
RUN npm i -g pnpm

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm --filter @workspace/yt-mp3 run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "artifacts/api-server/dist/index.mjs"]
```

Build and run:

```bash
docker build -t yt-mp3 .
docker run -d \
  -e DATABASE_URL=postgresql://... \
  -e SESSION_SECRET=... \
  -p 8080:8080 \
  -v /var/data/uploads:/app/artifacts/api-server/uploads \
  yt-mp3
```

---

## 8 — Run as a systemd service (Linux)

Create `/etc/systemd/system/yt-mp3.service`:

```ini
[Unit]
Description=YouTube to MP3 API Server
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/yt-mp3
ExecStart=/usr/bin/node artifacts/api-server/dist/index.mjs
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/yt_mp3
Environment=SESSION_SECRET=replace-with-secret

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable yt-mp3
sudo systemctl start yt-mp3
sudo journalctl -u yt-mp3 -f   # follow logs
```

---

## 9 — HTTPS (Let's Encrypt via Certbot)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot will auto-update your nginx config and set up automatic renewal.

---

## Upgrade procedure

```bash
git pull
pnpm install
pnpm run build
pnpm --filter @workspace/yt-mp3 run build
# If schema changed:
pnpm --filter @workspace/db run push
sudo systemctl restart yt-mp3
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DATABASE_URL` not set | Check `.env` or systemd `Environment=` lines |
| `yt-dlp: command not found` | Install yt-dlp or check `artifacts/api-server/bin/yt-dlp` exists |
| `ffmpeg: command not found` | `apt install ffmpeg` / `brew install ffmpeg` |
| Conversions immediately fail | Check API server logs: `journalctl -u yt-mp3` |
| Frontend shows blank page | Rebuild frontend: `pnpm --filter @workspace/yt-mp3 run build` |
| Large ZIP downloads fail | Ensure your reverse proxy `proxy_read_timeout` is ≥ 600s |
| Upload directory permission error | `chown -R www-data /var/data/yt-mp3-uploads` |
