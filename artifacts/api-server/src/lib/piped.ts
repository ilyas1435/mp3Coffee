import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { logger } from "./logger";
import { getApiHeaders, getBrowserHeaders } from "./useragents";

// Piped API instances — live-tested from this server's network (2026-05-30).
// Only confirmed-200 instances are listed; dead/unreachable ones are removed.
const DEFAULT_INSTANCES = [
  "https://api.piped.private.coffee",       // ✅ 200 (video info, not streams/playlists)
];

let instanceOrder: string[] = [...DEFAULT_INSTANCES];

function promoteInstance(url: string): void {
  instanceOrder = [url, ...instanceOrder.filter((i) => i !== url)];
}

// ─── URL parsing ────────────────────────────────────────────────────────────

const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube|youtube-nocookie)\.com$/i;

export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{6,}$/.test(id) ? id : null;
    }
    if (!YT_HOSTS.test(host)) return null;
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{6,}$/.test(v)) return v;
    const m = u.pathname.match(/\/(?:live|shorts|embed|v)\/([\w-]{6,})/);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

export function extractYouTubePlaylistId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!YT_HOSTS.test(host)) return null;
    const list = u.searchParams.get("list");
    if (list && /^[\w-]{10,}$/.test(list)) return list;
    return null;
  } catch {
    return null;
  }
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === "youtu.be" || YT_HOSTS.test(host);
  } catch {
    return false;
  }
}

// ─── Instance round-robin fetch ─────────────────────────────────────────────

const PIPED_GET_TIMEOUT_MS = 4000; // fail fast — yt-dlp fallback is available

async function pipedGet<T>(path: string, timeoutMs = PIPED_GET_TIMEOUT_MS): Promise<T> {
  let lastErr: unknown;
  for (const instance of instanceOrder) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${instance}${path}`, {
        signal: ctrl.signal,
        headers: getApiHeaders(),
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as T;
      promoteInstance(instance);
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      logger.debug({ instance, path, err: (e as Error).message }, "Piped instance failed");
    }
  }
  throw new Error(
    `All Piped instances unavailable: ${(lastErr as Error)?.message ?? lastErr}`
  );
}

// ─── Streams API ────────────────────────────────────────────────────────────

export interface PipedAudioStream {
  url: string;
  format: string;
  quality: string;
  mimeType: string;
  codec: string;
  bitrate: number;
}

export interface PipedVideo {
  title: string;
  duration: number;
  uploader?: string;
  audioStreams: PipedAudioStream[];
}

export async function fetchPipedVideo(videoId: string): Promise<PipedVideo> {
  const data = await pipedGet<PipedVideo>(`/streams/${encodeURIComponent(videoId)}`);
  if (!data.audioStreams || data.audioStreams.length === 0) {
    throw new Error("Piped: no audio streams returned (video may be private/age-restricted)");
  }
  return data;
}

export function pickBestAudio(streams: PipedAudioStream[]): PipedAudioStream {
  // Prefer opus (smaller, equivalent quality) at highest bitrate, else m4a.
  const sorted = [...streams].sort((a, b) => b.bitrate - a.bitrate);
  return sorted.find((s) => s.codec === "opus") ?? sorted[0];
}

// ─── Playlist API (with full pagination) ────────────────────────────────────

export interface PipedPlaylistVideo {
  id: string;
  title: string;
  url: string;
}

export interface PipedPlaylistResult {
  name: string;
  items: PipedPlaylistVideo[];
}

interface PipedRelatedStream {
  url?: string;
  title?: string;
}

function mapRelatedStreams(streams: PipedRelatedStream[]): PipedPlaylistVideo[] {
  return streams
    .map((v) => {
      const path = v.url ?? "";
      const m = path.match(/[?&]v=([\w-]+)/) ?? path.match(/\/watch\/([\w-]+)/);
      const id = m?.[1];
      if (!id) return null;
      return {
        id,
        title: v.title ?? id,
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    })
    .filter((v): v is PipedPlaylistVideo => v !== null);
}

export async function fetchPipedPlaylist(playlistId: string): Promise<PipedPlaylistResult> {
  const first = await pipedGet<{
    name?: string;
    relatedStreams?: PipedRelatedStream[];
    nextpage?: string | null;
  }>(`/playlists/${encodeURIComponent(playlistId)}`);

  let allItems = mapRelatedStreams(first.relatedStreams ?? []);
  let nextpage = first.nextpage ?? null;
  const seen = new Set<string>(allItems.map((i) => i.id));

  // Paginate through all pages to fetch the full playlist (no 100-video cap)
  while (nextpage) {
    try {
      const page = await pipedGet<{
        relatedStreams?: PipedRelatedStream[];
        nextpage?: string | null;
      }>(
        `/nextpage/playlists/${encodeURIComponent(playlistId)}?nextpage=${encodeURIComponent(nextpage)}`
      );

      const pageItems = mapRelatedStreams(page.relatedStreams ?? []);
      const fresh = pageItems.filter((v) => !seen.has(v.id));
      if (fresh.length === 0) break; // no new items — stop paginating
      for (const v of fresh) seen.add(v.id);
      allItems = [...allItems, ...fresh];

      const next = page.nextpage ?? null;
      nextpage = next && next !== nextpage ? next : null;
    } catch (e) {
      logger.warn({ playlistId, err: (e as Error).message }, "Piped playlist pagination failed, using partial results");
      break;
    }
  }

  return { name: first.name ?? "", items: allItems };
}

// ─── Playlist title via direct page fetch (last-resort fallback) ───────────
// Used when both Piped and yt-dlp fail to return a playlist name (e.g. for
// Mix/radio playlists or when yt-dlp hits bot detection without cookies).

export async function fetchPlaylistTitleViaPage(playlistId: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
      { headers: getBrowserHeaders() }
    );
    if (!res.ok) return undefined;
    const html = await res.text();
    const match = html.match(/<title>([^<]*)<\/title>/i);
    if (!match) return undefined;
    let title = match[1].replace(/\s*-\s*YouTube\s*$/i, "").trim();
    title = title
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    return title && title.toLowerCase() !== "youtube" ? title : undefined;
  } catch {
    return undefined;
  }
}

// ─── Audio download ─────────────────────────────────────────────────────────

export interface DownloadOptions {
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

export interface DownloadedAudio {
  filePath: string;
  ext: string;
  bytes: number;
}

function extFromMime(mime: string, codec: string): string {
  if (codec === "opus" || mime.includes("webm")) return "webm";
  if (codec.startsWith("mp4a") || mime.includes("mp4")) return "m4a";
  return "audio";
}

export async function downloadPipedStream(
  stream: PipedAudioStream,
  outputPathWithoutExt: string,
  opts: DownloadOptions = {}
): Promise<DownloadedAudio> {
  const ext = extFromMime(stream.mimeType, stream.codec);
  const filePath = `${outputPathWithoutExt}.${ext}`;

  const res = await fetch(stream.url, {
    signal: opts.signal,
    headers: getBrowserHeaders(),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Piped CDN returned HTTP ${res.status}`);
  }

  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? parseInt(totalHeader, 10) : 0;
  let received = 0;
  let lastReportedPct = -1;

  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
  const nodeStream = new Readable({
    read() {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            this.push(null);
            return;
          }
          received += value.byteLength;
          if (opts.onProgress && total > 0) {
            const pct = Math.min(99, Math.floor((received / total) * 100));
            if (pct !== lastReportedPct) {
              lastReportedPct = pct;
              opts.onProgress(pct);
            }
          }
          this.push(Buffer.from(value));
        })
        .catch((err) => this.destroy(err));
    },
  });

  await pipeline(nodeStream, createWriteStream(filePath));
  if (opts.onProgress) opts.onProgress(100);

  return { filePath, ext, bytes: received };
}
