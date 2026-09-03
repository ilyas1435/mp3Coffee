# Workspace

## Overview

pnpm workspace monorepo using TypeScript. YouTube to MP3 Converter web app.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite (Tailwind CSS, framer-motion)
- **Audio tools**: yt-dlp (at /tmp/yt-dlp-latest via python3.10), ffmpeg

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server (conversions routes)
│   └── yt-mp3/             # React + Vite frontend
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Key Features

- Accepts URLs from YouTube, SoundCloud, and 1000+ sites supported by yt-dlp
- Audio settings: bitrate (8–320 kbps), bitrate type (ABR/VBR/CBR), sample rate, channels
- Settings are saved to localStorage and persist across sessions
- Background job processing with database persistence (jobs survive server restarts)
- Real-time progress updates via polling (2s interval when jobs are active)
- Progress percentage + status label display
- Playlist support: downloads all tracks, converts each, zips into a single archive
- Files named after the original video/track title (RFC 5987 encoded Content-Disposition for Unicode titles)
- Delete all converted files with a single button
- Disk space indicator showing free space and space used by converted files
- Downloaded files are visually distinguished in history (muted/grey style, "Download again" button)
- Defaults: 16kbps ABR, 8000Hz, mono (maximum compression)

## Audio Processing

- **YouTube fetcher (primary)**: Public Piped instances (`artifacts/api-server/src/lib/piped.ts`).
  YouTube blocks Replit's datacenter IPs with "Sign in to confirm you're not a bot" on every
  yt-dlp player_client. Piped's API runs on residential IPs and proxies the audio CDN URL back to
  us, completely bypassing the bot wall — no cookies needed. Tries a list of mirrors with auto
  promotion of the last good one. Used for both single videos (`/streams/:id`) and playlists
  (`/playlists/:id`). Falls back to yt-dlp on Piped failure.
- **yt-dlp (fallback / non-YouTube)**: Stored at `artifacts/api-server/bin/yt-dlp` (persistent),
  downloaded by `setup.sh` on server start. Used directly for SoundCloud and the other 1000+
  supported sites, and as a fallback when Piped fails.
  - Run via `python3.10 bin/yt-dlp ...`
  - Uses `-N 4 --concurrent-fragments 4` for parallel download chunks
  - Auto-prepends `--cookies cookies.txt` if the file exists (set via `/api/cookies`)
- **ffmpeg**: System ffmpeg — used for the actual MP3 encoding (bitrate, sample rate, channels,
  atempo speed) regardless of which fetcher produced the raw audio.
- Output MP3s stored in `artifacts/api-server/uploads/`

## API Routes

- `GET /api/conversions` - list all conversions
- `POST /api/conversions` - create a new conversion job
- `GET /api/conversions/:id` - get a conversion job status
- `GET /api/conversions/:id/download` - download the converted MP3
- `DELETE /api/conversions/:id` - delete a single conversion + its files
- `DELETE /api/conversions` - delete conversions; body `{ids:[...]}` for selective, empty body wipes all
- `POST /api/conversions/bulk-download` - body `{ids:[...]}`; bundles selected done conversions into a new ZIP entry, deletes the source files & rows
- `GET /api/playlist-info` - preflight playlist track listing
- `GET /api/disk-space` - free disk + uploads dir size

## HTTP Server Timeouts

`artifacts/api-server/src/index.ts` disables `requestTimeout`, `headersTimeout`, and `timeout` on the Node HTTP server so long-running playlist scans and big bundle downloads are never cut off mid-flight. `keepAliveTimeout` is set to 120s.

## Database Schema

- `conversions` table with status, progress, audio settings, file path

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`.

- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly`
- `pnpm --filter @workspace/api-spec run codegen` — regenerates React Query hooks and Zod schemas

## Notes

- yt-dlp binary is stored in `artifacts/api-server/bin/yt-dlp` (persists across restarts). `setup.sh` runs automatically on `pnpm run dev` and downloads yt-dlp if missing. Python 3.10 is installed via nix on first start.
- MP3 output files are stored in `artifacts/api-server/uploads/` and are not cleaned up automatically.
- The `youtubeUrl` field in the DB/API is a legacy name — it accepts any URL supported by yt-dlp.
