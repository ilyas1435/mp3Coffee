import { Router, type IRouter } from "express";
import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync, rmSync } from "fs";
import { join, extname } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import archiver from "archiver";
import { createWriteStream } from "fs";
import { db } from "@workspace/db";
import { conversionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  CreateConversionBody,
  GetConversionParams,
  DownloadConversionParams,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  isYouTubeUrl,
  extractYouTubeId,
  extractYouTubePlaylistId,
  fetchPipedVideo,
  fetchPipedPlaylist,
  fetchPlaylistTitleViaPage,
  pickBestAudio,
  downloadPipedStream,
  type PipedPlaylistResult,
} from "../lib/piped";
import { fetchInvidiousVideo, pickBestInvidiousAudio } from "../lib/invidious";
import { getRandomUserAgent } from "../lib/useragents";
import { youtubePlaylistQueue } from "../lib/youtube-playlist-queue";

const router: IRouter = Router();

const UPLOADS_DIR = join(process.cwd(), "uploads");
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const BIN_DIR = join(process.cwd(), "bin");
const YTDLP_BIN = join(BIN_DIR, "yt-dlp");
export const COOKIES_FILE = join(process.cwd(), "cookies.txt");

// Playlist concurrency — use available CPU; each worker is mostly I/O-bound
// This is deliberately scoped inside one playlist job. Complete YouTube
// playlist jobs are serialized by youtubePlaylistQueue below.
const PLAYLIST_CONCURRENCY = 6;

// Per-track download + convert timeout — generous to handle slow servers
const TRACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Active job tracking (for cancel) ───────────────────────────────────────

interface ActiveJob {
  procs: Set<ReturnType<typeof spawn>>;
  aborters: Set<AbortController>;
  cancelled: boolean;
}
const activeJobs = new Map<number, ActiveJob>();

function registerProc(jobId: number, proc: ReturnType<typeof spawn>): ReturnType<typeof spawn> {
  const job = activeJobs.get(jobId);
  if (job) {
    job.procs.add(proc);
    proc.on("close", () => job.procs.delete(proc));
  }
  return proc;
}

function registerAborter(jobId: number): AbortController {
  const ctrl = new AbortController();
  const job = activeJobs.get(jobId);
  if (job) job.aborters.add(ctrl);
  return ctrl;
}

function releaseAborter(jobId: number, ctrl: AbortController): void {
  activeJobs.get(jobId)?.aborters.delete(ctrl);
}

function throwIfCancelled(jobId: number): void {
  if (activeJobs.get(jobId)?.cancelled) throw new Error("Cancelled");
}

// ─── Cookies enabled state (togglable via settings) ───────────────────────

let _cookiesEnabled = true;
export function setCookiesEnabled(enabled: boolean): void { _cookiesEnabled = enabled; }
export function getCookiesEnabled(): boolean { return _cookiesEnabled; }

// ─── Generic retry helper (for 403/429/transient errors) ─────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 2000,
  label = "",
): Promise<T> {
  let lastErr: Error = new Error("Unknown");
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg: string = e?.message ?? "";
      // Never retry a cancellation — propagate immediately
      if (msg === "Cancelled" || msg.includes("Cancelled")) throw e;
      if (attempt === retries) break;
      // Retry everything except hard "not available" signals that won't change
      const isFatal = /private video|members.only|sign in to confirm|not available in your country/i.test(msg);
      if (isFatal) break;
      const delay = Math.min(baseDelayMs * attempt, 8000);
      logger.warn({ attempt, retries, label, err: msg, delayMs: delay }, "Retrying after error");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function cancelJob(jobId: number): void {
  const job = activeJobs.get(jobId);
  if (!job) return;
  job.cancelled = true;
  for (const proc of job.procs) {
    try { proc.kill("SIGTERM"); } catch (_) {}
  }
  for (const ctrl of job.aborters) {
    try { ctrl.abort(); } catch (_) {}
  }
  job.procs.clear();
  job.aborters.clear();
  // Keep the cancellation marker until the runner's finally block. This is
  // important for queued playlists and also lets an active runner observe the
  // cancellation instead of reporting a process kill as a generic failure.
}

function isYouTubePlaylistOperation(
  job: Pick<typeof conversionsTable.$inferSelect, "youtubeUrl" | "sourceUrls">,
): boolean {
  const urls = Array.isArray(job.sourceUrls) && job.sourceUrls.length > 0
    ? job.sourceUrls
    : [job.youtubeUrl];
  return urls.some((url) => Boolean(extractYouTubePlaylistId(url)));
}

// ─── Timeout helper for frozen tracks ────────────────────────────────────────

async function withTrackTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Track timed out after ${Math.round(ms / 1000)}s: ${label}`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPythonPath(): string {
  const candidates = [
    "/home/runner/.nix-profile/bin/python3.10",
    "/home/runner/.nix-profile/bin/python3",
    "/usr/bin/python3.10",
    "/usr/bin/python3",
    "python3.10",
    "python3",
  ];
  for (const p of candidates) {
    if (p.startsWith("/") && existsSync(p)) return p;
  }
  return "python3";
}

// Player-client args per download server mode — bypass YouTube bot detection.
// yt-dlp tries clients left-to-right and stops at the first that works.
const PLAYER_CLIENT_ARGS: Record<string, string[]> = {
  // Single-client modes (user-selectable)
  // NOTE: tv_embedded is excluded because when combined with stale/expired cookies
  // it causes "Requested format is not available" on every video. 
  // If cookies are fresh, the user can use "best" mode which still works.
  android:           ["--extractor-args", "youtube:player_client=android,web"],
  ios:               ["--extractor-args", "youtube:player_client=ios,web"],
  tv:                ["--extractor-args", "youtube:player_client=tv_embedded,web"],
  mweb:              ["--extractor-args", "youtube:player_client=mweb,web"],
  android_testsuite: ["--extractor-args", "youtube:player_client=android_testsuite,web"],
  // "best" = yt-dlp tries all viable clients automatically; most robust option.
  // tv_embedded is intentionally excluded because it fails when cookies are stale.
  best: [
    "--extractor-args",
    "youtube:player_client=android_testsuite,ios,android,mweb,web",
    "--geo-bypass",
  ],
};

function runYtDlp(args: string[], extraArgs: string[] = []): ReturnType<typeof spawn> {
  const cookieArgs = (_cookiesEnabled && existsSync(COOKIES_FILE)) ? ["--cookies", COOKIES_FILE] : [];
  // Rotate UA on every call unless caller already set one
  const uaArgs = extraArgs.some(a => a === "--user-agent") ? [] : ["--user-agent", getRandomUserAgent()];
  // Always add geo-bypass unless already present
  const geoArgs = extraArgs.includes("--geo-bypass") ? [] : ["--geo-bypass"];
  // Global performance / privacy flags unless already overridden by the caller
  const perfArgs = [
    "--no-call-home",
    ...(extraArgs.includes("--no-check-formats") ? [] : ["--no-check-formats"]),
    ...(extraArgs.includes("--no-warnings") ? [] : ["--no-warnings"]),
  ];
  const finalArgs = [...cookieArgs, ...uaArgs, ...geoArgs, ...perfArgs, ...extraArgs, ...args];
  if (existsSync(YTDLP_BIN)) {
    return spawn(getPythonPath(), [YTDLP_BIN, ...finalArgs]);
  }
  return spawn("yt-dlp", finalArgs);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 180)
    .trim() || "audio";
}

function contentDisposition(filename: string): string {
  const asciiOnly = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27");
  return `attachment; filename="${asciiOnly}"; filename*=UTF-8''${encoded}`;
}

function cleanJobFiles(jobId: number): void {
  try {
    const files = readdirSync(UPLOADS_DIR).filter(f => f.startsWith(`${jobId}_`) || f.startsWith(`${jobId}-`));
    for (const f of files) {
      try { unlinkSync(join(UPLOADS_DIR, f)); } catch (_) {}
    }
  } catch (_) {}
}

function safeUnlink(f: string): void {
  try { if (f && existsSync(f)) unlinkSync(f); } catch (_) {}
}

function getFfmpegBitrateArgs(bitrate: number, bitrateType: string): string[] {
  switch (bitrateType) {
    case "cbr":
      return ["-b:a", `${bitrate}k`, "-minrate", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`];
    case "vbr": {
      const qMap: Record<number, number> = { 8: 9, 16: 9, 32: 8, 64: 6, 128: 2, 192: 1, 320: 0 };
      const closest = Object.keys(qMap).map(Number).sort((a, b) => Math.abs(a - bitrate) - Math.abs(b - bitrate))[0];
      return ["-q:a", String(qMap[closest] ?? 9)];
    }
    default:
      return ["-b:a", `${bitrate}k`];
  }
}

function buildAtempoChain(speed: number): string {
  if (speed <= 0 || Math.abs(speed - 1) < 0.001) return "";
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0) { filters.push("atempo=2.0"); remaining /= 2.0; }
  while (remaining < 0.5) { filters.push("atempo=0.5"); remaining /= 0.5; }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(",");
}

// ─── yt-dlp wrappers ─────────────────────────────────────────────────────────

async function fetchTitle(url: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = runYtDlp(["--no-playlist", "--no-warnings", "--no-check-formats", "--no-call-home", "--print", "%(title)s", url]);
    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr?.on("data", () => {});
    proc.on("close", () => resolve(out.trim().split("\n")[0] ?? ""));
    proc.on("error", () => resolve(""));
  });
}

function buildFormatForLanguage(lang: string): string {
  if (!lang || lang === "original") {
    // language_preference > 0 means yt-dlp considers this stream the original language
    // for the video (it sets -1 on dubbed tracks). This prevents a higher-bitrate dub
    // from winning the selection. The final fallback covers single-track videos.
    return "worstaudio[language_preference>0]/bestaudio[language_preference>0]/worstaudio/bestaudio";
  }
  // Dubbed track: prefer worst audio tagged with the requested language, fall back to best
  // tagged, then fall all the way back to any audio so the job never hard-fails.
  return `worstaudio[language=${lang}]/bestaudio[language=${lang}]/worstaudio/bestaudio`;
}

async function downloadSingle(
  jobId: number,
  url: string,
  outputTemplate: string,
  onProgress?: (pct: number) => void,
  extraArgs: string[] = [],
  audioFormat = "worstaudio[language_preference>0]/bestaudio[language_preference>0]/worstaudio/bestaudio",
): Promise<string> {
  // YouTube format fields (worstaudio, language_preference, etc.) must never be
  // sent to other extractors. Sites such as Internet Archive expose arbitrary
  // format IDs, so the portable selector is simply the best available source.
  const format = isYouTubeUrl(url) ? audioFormat : "best";
  const youtubeFormatArgs = isYouTubeUrl(url)
    ? [
        // Keep the original language ahead of quality when alternate audio tracks
        // are present, and verify filtered formats instead of trusting stale metadata.
        "--format-sort", "lang,quality",
        "--format-sort-force",
        "--check-formats",
      ]
    : [];
  const dlArgs = [
    "--no-playlist", "--no-warnings",
    "-f", format,
    ...youtubeFormatArgs,
    "--extract-audio", "--audio-quality", "0",
    "--concurrent-fragments", "4", "-N", "4",
    "--buffer-size", "64K",
    "--socket-timeout", "15",
    "--retries", "5",
    "--fragment-retries", "5",
    "--no-part",
    "--newline", "--progress",
    "-o", outputTemplate,
    url,
  ];


  return new Promise((resolve, reject) => {
    const dl = registerProc(jobId, runYtDlp(dlArgs, extraArgs));
    let rawFile = "";
    const allLines: string[] = [];

    const handleLine = (line: string) => {
      const t = line.trim();
      if (!t) return;
      if (allLines.length >= 40) allLines.shift();
      allLines.push(t);
      if (onProgress) {
        const m = t.match(/(\d+\.\d+)%/);
        if (m) onProgress(parseFloat(m[1]));
      }
      const destMatch = t.match(/\[ExtractAudio\] Destination: (.+)/);
      if (destMatch) rawFile = destMatch[1].trim();
      const mergeMatch = t.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergeMatch) rawFile = mergeMatch[1].trim();
      const dlDestMatch = t.match(/\[download\] Destination: (.+)/);
      if (dlDestMatch && !rawFile) rawFile = dlDestMatch[1].trim();
    };

    dl.stdout?.on("data", (c: Buffer) => c.toString().split("\n").forEach(handleLine));
    dl.stderr?.on("data", (c: Buffer) => c.toString().split("\n").forEach(handleLine));

    dl.on("close", (code) => {
      if (activeJobs.get(jobId)?.cancelled) { reject(new Error("Cancelled")); return; }
      if (code !== 0) {
        // Find the most useful error line — prefer lines with ERROR:, then any non-progress line
        const errLine = allLines.slice().reverse().find(l => /^ERROR:/i.test(l))
          ?? allLines.slice().reverse().find(l => !/^\[download\]/.test(l) && !/^\d+\.\d+%/.test(l))
          ?? allLines[allLines.length - 1];
        const cleaned = errLine
          ? errLine.replace(/^ERROR:\s*/i, "").replace(/^\[[^\]]+\]\s*/, "").trim()
          : "";
        logger.warn({ jobId, url, code, lastLines: allLines.slice(-6) }, "yt-dlp failed");
        reject(new Error(cleaned ? `yt-dlp: ${cleaned}` : `yt-dlp exited with code ${code}`));
        return;
      }

      if (!rawFile || !existsSync(rawFile)) {
        const prefix = outputTemplate.replace(/\.%\(ext\)s$/, "").split("/").pop()!;
        const found = readdirSync(UPLOADS_DIR)
          .filter(f => f.startsWith(prefix) && !f.endsWith(".mp3") && !f.endsWith(".zip"))
          .sort()
          .map(f => join(UPLOADS_DIR, f));
        if (found.length > 0) rawFile = found[found.length - 1];
      }

      if (!rawFile || !existsSync(rawFile)) {
        reject(new Error(`Downloaded audio file not found. Template: ${outputTemplate}`));
        return;
      }
      resolve(rawFile);
    });

    dl.on("error", reject);
  });
}

async function convertToMp3(
  jobId: number,
  rawFile: string,
  outputMp3: string,
  job: { bitrate: number; bitrateType: string; sampleRate: number; channels: number; speed: number },
  onProgress?: (frac: number) => void,
): Promise<void> {
  const atempo = buildAtempoChain(job.speed);
  const filterArgs = atempo ? ["-filter:a", atempo] : [];
  const ffArgs = [
    "-i", rawFile,
    "-vn",
    ...filterArgs,
    "-ar", job.sampleRate.toString(),
    "-ac", job.channels === 1 ? "1" : "2",
    ...getFfmpegBitrateArgs(job.bitrate, job.bitrateType),
    "-codec:a", "libmp3lame",
    "-compression_level", "0",
    "-threads", "0",
    "-y", outputMp3,
  ];

  return new Promise((resolve, reject) => {
    const ff = registerProc(jobId, spawn("ffmpeg", ffArgs));
    let duration = 0;

    ff.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (durMatch) {
        duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
      }
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && duration > 0 && onProgress) {
        const cur = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
        onProgress(Math.min(cur / duration, 1));
      }
    });

    ff.on("close", (code) => {
      if (activeJobs.get(jobId)?.cancelled) { reject(new Error("Cancelled")); return; }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    ff.on("error", reject);
  });
}


async function detectPlaylistEntries(url: string): Promise<{ id: string; title: string; url: string }[] | null> {
  return new Promise((resolve) => {
    const proc = runYtDlp([
      "--flat-playlist",
      "--no-warnings",
      "--no-check-formats",
      "--no-call-home",
      "--print", "%(id)s\t%(title)s\t%(url)s",
      url,
    ]);
    let output = "";
    proc.stdout?.on("data", (c: Buffer) => { output += c.toString(); });

    proc.on("close", (code) => {
      const lines = output.trim().split("\n").filter(Boolean);
      const entries = lines.map(line => {
        const parts = line.split("\t");
        return { id: parts[0] ?? "", title: parts[1] ?? "", url: parts[2] ?? "" };
      }).filter(e => e.id && e.url);

      // هنا المفتاح: هل هناك احتمالية لوجود المزيد؟
      // إذا كان العدد 100 بالضبط، فهذا يعني غالباً أن هناك pagination لم يتم جلبه
      if (entries.length >= 100) {
        // نصيحة: إذا استمرت المشكلة هنا، يجب إضافة "--playlist-random" 
        // أو التحقق من وجود ملف cookies.txt في المجلد الرئيسي
      }

      resolve(entries.length > 0 ? entries : null);
    });

    proc.on("error", () => resolve(null));
  });
}


async function fetchPlaylistTitleViaYtDlp(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = runYtDlp(["--flat-playlist", "--no-playlist-items", "--no-warnings", "--no-check-formats", "--no-call-home", "--print", "%(playlist_title)s", url]);
    let output = "";
    proc.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
    proc.stderr?.on("data", () => {});
    proc.on("close", () => {
      const title = output.trim().split("\n")[0]?.trim();
      resolve(title && title !== "NA" && title !== "None" ? title : undefined);
    });
    proc.on("error", () => resolve(undefined));
  });
}

// ─── Smart wrappers: prefer Piped for YouTube (bypasses bot detection) ──────

interface PlaylistMeta {
  entries: { id: string; title: string; url: string }[];
  name?: string;
}

// In-memory cache for playlist-info scans to speed up repeated URL checks
const playlistInfoCache = new Map<string, { meta: PlaylistMeta | null; ts: number }>();
const PLAYLIST_INFO_CACHE_TTL_MS = 60_000; // 1 minute

function deriveNameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    // Don't use the raw `list=` playlist ID as a name — it's not human-readable.
    // Returning undefined here lets callers fall through to a friendlier default
    // like "Playlist (N tracks)".
    if (u.searchParams.get("list")) return undefined;
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last).replace(/[-_]/g, " ") : undefined;
  } catch { return undefined; }
}

// YouTube's innertube continuation page size — if a source returns exactly
// this many items, it's a strong signal that pagination stopped early
// (broken `nextpage` cursor, instance quirk, etc.) rather than the playlist
// genuinely having 100 items. We cross-check against the other source in
// that case instead of trusting it blindly.
const SUSPICIOUS_PAGE_SIZE = 100;

async function detectPlaylistEntriesSmart(url: string): Promise<PlaylistMeta | null> {
  const ytPlaylistId = extractYouTubePlaylistId(url);
  if (ytPlaylistId) {
    let pipedResult: PipedPlaylistResult | null = null;
    try {
      pipedResult = await fetchPipedPlaylist(ytPlaylistId);
    } catch (e) {
      logger.warn({ url, err: (e as Error).message }, "Piped playlist failed, falling back to yt-dlp");
    }

    const pipedItems = pipedResult?.items ?? [];
    const pipedLooksTruncated = pipedItems.length === SUSPICIOUS_PAGE_SIZE;

    // Fast path: Piped returned a believable (non-100, non-empty) count — trust it, no extra calls.
    if (pipedItems.length > 1 && !pipedLooksTruncated) {
      const name = pipedResult!.name
        || await fetchPlaylistTitleViaYtDlp(url).catch(() => undefined)
        || await fetchPlaylistTitleViaPage(ytPlaylistId).catch(() => undefined);
      return { entries: pipedItems, name: name || deriveNameFromUrl(url) };
    }

    // Piped failed, returned ≤1 item, or hit the suspicious 100-item cap — cross-check with yt-dlp,
    // which paginates the full playlist independently of Piped's instance/cursor behavior.
    const [ytEntries, ytTitle] = await Promise.all([
      detectPlaylistEntries(url),
      fetchPlaylistTitleViaYtDlp(url),
    ]);

    const ytCount = ytEntries?.length ?? 0;
    const pipedCount = pipedItems.length;
    if (pipedLooksTruncated && ytCount <= pipedCount) {
      logger.warn({ url, pipedCount, ytCount }, "Piped playlist count looked truncated at 100, but yt-dlp didn't return more");
    }

    const finalEntries = ytCount > pipedCount ? ytEntries : (pipedCount > 0 ? pipedItems : ytEntries);
    if (!finalEntries || finalEntries.length === 0) return null;

    const resolvedName = pipedResult?.name
      || ytTitle
      || await fetchPlaylistTitleViaPage(ytPlaylistId).catch(() => undefined);
    return { entries: finalEntries, name: resolvedName || deriveNameFromUrl(url) };
  }
  // Not a YouTube playlist URL (no `list=` param): non-YouTube sites handled below
  if (isYouTubeUrl(url)) return null; // single YouTube video
  // For non-YouTube (e.g. Archive.org), fetch entries and playlist title concurrently
  const [entries, nonYtTitle] = await Promise.all([
    detectPlaylistEntries(url),
    fetchPlaylistTitleViaYtDlp(url),
  ]);
  return entries ? { entries, name: nonYtTitle || deriveNameFromUrl(url) } : null;
}

async function fetchTitleSmart(url: string): Promise<string> {
  const id = extractYouTubeId(url);
  if (id) {
    try {
      const v = await fetchPipedVideo(id);
      if (v.title) return v.title;
    } catch (e) {
      logger.debug({ url, err: (e as Error).message }, "Piped title fetch failed; trying yt-dlp");
    }
  }
  return fetchTitle(url);
}

/**
 * downloadServer options:
 *   "auto"             — Piped → Invidious → yt-dlp best-clients → direct
 *   "piped"            — Piped only
 *   "invidious"        — Invidious only
 *   "best"             — yt-dlp cycling all player clients
 *   "android"          — yt-dlp Android client
 *   "android_testsuite"— yt-dlp Android test suite client
 *   "ios"              — yt-dlp iOS client
 *   "tv"               — yt-dlp TV Embedded client
 *   "mweb"             — yt-dlp Mobile Web client
 *   "direct"           — yt-dlp, no client override
 */
async function downloadSingleSmart(
  jobId: number,
  url: string,
  outputTemplate: string,
  downloadServer: string,
  onProgress?: (pct: number) => void,
  opts: { skipStreaming?: boolean; audioLanguage?: string } = {},
): Promise<string> {
  const audioFormat = buildFormatForLanguage(opts.audioLanguage ?? "original");
  const id = extractYouTubeId(url);
  const isYoutube = !!id;
  // yt-dlp-only modes — skip all streaming backends
  if (isYoutube && downloadServer in PLAYER_CLIENT_ARGS) {
    return downloadSingle(jobId, url, outputTemplate, onProgress, PLAYER_CLIENT_ARGS[downloadServer], audioFormat);
  }
  if (downloadServer === "direct") {
    return downloadSingle(jobId, url, outputTemplate, onProgress, [], audioFormat);
  }

  // Invidious-only mode: no instances are currently available, fall back to yt-dlp
  if (downloadServer === "invidious") {
    logger.warn({ jobId, url }, "Invidious mode selected but no instances available; using yt-dlp");
    return downloadSingle(jobId, url, outputTemplate, onProgress, isYoutube ? PLAYER_CLIENT_ARGS.best : [], audioFormat);
  }

  // Piped doesn't expose language-tagged tracks — skip it when a non-original language is requested
  const useLanguageFilter = !!opts.audioLanguage && opts.audioLanguage !== "original";

  // Streaming paths (Piped only) — skipped when caller already tried them upstream or language filter requested
  // Do not use Piped for an explicit original-language request. Piped returns its
  // preferred stream and can select a dub; yt-dlp is required for exact track choice.
  const useExactOriginal = !opts.audioLanguage || opts.audioLanguage === "original";
  if (!opts.skipStreaming && !useLanguageFilter && !useExactOriginal && id) {
    // Piped path
    try {
      const v = await fetchPipedVideo(id);
      throwIfCancelled(jobId);
      const audio = pickBestAudio(v.audioStreams);
      const ctrl = registerAborter(jobId);
      try {
        const outBase = outputTemplate.replace(/\.%\(ext\)s$/, "");
        const dl = await downloadPipedStream(audio, outBase, { signal: ctrl.signal, onProgress });
        return dl.filePath;
      } finally {
        releaseAborter(jobId, ctrl);
      }
    } catch (e: any) {
      if (e?.name === "AbortError" || activeJobs.get(jobId)?.cancelled) throw new Error("Cancelled");
      logger.warn({ jobId, url, err: e?.message }, "Piped failed, falling back to yt-dlp");
    }
  }

  // yt-dlp: for YouTube use all viable player clients; for others use plain download
  if (id) {
    try {
      throwIfCancelled(jobId);
      return await downloadSingle(jobId, url, outputTemplate, onProgress, PLAYER_CLIENT_ARGS.best, audioFormat);
    } catch (e: any) {
      if (e?.message === "Cancelled" || activeJobs.get(jobId)?.cancelled) throw e;
      logger.warn({ jobId, url, err: e?.message }, "All-clients yt-dlp failed, trying plain fallback");
    }
  }

  // Final fallback: plain yt-dlp (non-YouTube or all clients failed)
  return downloadSingle(jobId, url, outputTemplate, onProgress, [], audioFormat);
}

// ─── Pipe Piped audio stream directly to ffmpeg (no temp file) ──────────────

async function pipePipedStreamToMp3(
  jobId: number,
  audioUrl: string,
  duration: number,
  outputMp3: string,
  job: { bitrate: number; bitrateType: string; sampleRate: number; channels: number; speed: number },
  onProgress?: (frac: number) => void,
): Promise<void> {
  const atempo = buildAtempoChain(job.speed);
  const filterArgs = atempo ? ["-filter:a", atempo] : [];
  const ffArgs = [
    "-i", "pipe:0",
    "-vn",
    ...filterArgs,
    "-ar", job.sampleRate.toString(),
    "-ac", job.channels === 1 ? "1" : "2",
    ...getFfmpegBitrateArgs(job.bitrate, job.bitrateType),
    "-codec:a", "libmp3lame",
    "-compression_level", "0",
    "-threads", "0",
    "-y", outputMp3,
  ];

  const ctrl = registerAborter(jobId);
  try {
    const fetchRes = await fetch(audioUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    });
    if (!fetchRes.ok || !fetchRes.body) {
      throw new Error(`Audio CDN returned HTTP ${fetchRes.status}`);
    }

    const ff = registerProc(jobId, spawn("ffmpeg", ffArgs));

    ff.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && duration > 0 && onProgress) {
        const cur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
        onProgress(Math.min(cur / duration, 1));
      }
    });

    if (!ff.stdin) {
      throw new Error("ffmpeg stdin is unavailable");
    }
    Readable.fromWeb(fetchRes.body as any).pipe(ff.stdin);

    await new Promise<void>((resolve, reject) => {
      ff.on("close", (code) => {
        if (activeJobs.get(jobId)?.cancelled) { reject(new Error("Cancelled")); return; }
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      ff.on("error", reject);
    });
  } finally {
    releaseAborter(jobId, ctrl);
  }
}

// ─── Archive URL detection & conversion (ZIP → audio files → MP3 ZIP) ───────

const ARCHIVE_MEDIA_EXTS = new Set([
  // Audio formats
  ".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".opus", ".wma", ".aiff", ".ape", ".wv", ".dsf", ".dts",
  // Video formats (extracted to audio via ffmpeg)
  ".mp4", ".m4v", ".avi", ".mkv", ".mov", ".qt", ".webm", ".flv", ".f4v", ".wmv", ".mpg", ".mpeg", ".ts", ".vob", ".3gp", ".ogv", ".divx", ".xvid", ".rm", ".rmvb", ".asf", ".dv",
]);

function isArchiveUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return [".zip", ".rar", ".7z", ".tar.gz", ".tar.bz2"].some((e) => p.endsWith(e));
  } catch { return false; }
}

function getArchiveExt(url: string): string {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".tar.gz")) return ".tar.gz";
    if (p.endsWith(".tar.bz2")) return ".tar.bz2";
    return extname(p) || ".zip";
  } catch { return ".zip"; }
}

function walkForAudio(dir: string): string[] {
  const result: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...walkForAudio(full));
      else if (ARCHIVE_MEDIA_EXTS.has(extname(entry.name).toLowerCase())) result.push(full);
    }
  } catch {}
  return result;
}

async function runArchiveConversion(jobId: number, url: string, job: typeof conversionsTable.$inferSelect): Promise<void> {
  const archiveExt = getArchiveExt(url);
  const archivePath = join(UPLOADS_DIR, `${jobId}_archive${archiveExt}`);
  const extractDir = join(UPLOADS_DIR, `${jobId}_extracted`);

  await db.update(conversionsTable)
    .set({ statusLabel: "Downloading archive...", progress: 3 })
    .where(eq(conversionsTable.id, jobId));

  const ctrl = registerAborter(jobId);
  try {
    const fetchRes = await fetch(url, { signal: ctrl.signal });
    if (!fetchRes.ok || !fetchRes.body) throw new Error(`Download failed: HTTP ${fetchRes.status}`);

    const totalHeader = fetchRes.headers.get("content-length");
    const total = totalHeader ? parseInt(totalHeader, 10) : 0;
    let received = 0;

    const nodeStream = Readable.fromWeb(fetchRes.body as any);
    nodeStream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.round((received / total) * 17);
        db.update(conversionsTable)
          .set({ statusLabel: `Downloading... ${Math.round((received / total) * 100)}%`, progress: 3 + pct })
          .where(eq(conversionsTable.id, jobId)).catch(() => {});
      }
    });
    await pipeline(nodeStream, createWriteStream(archivePath));
  } finally {
    releaseAborter(jobId, ctrl);
  }

  throwIfCancelled(jobId);

  await db.update(conversionsTable)
    .set({ statusLabel: "Extracting archive...", progress: 22 })
    .where(eq(conversionsTable.id, jobId));

  mkdirSync(extractDir, { recursive: true });

  if (archiveExt !== ".zip") {
    throw new Error(`Only ZIP archives are supported (got ${archiveExt}). RAR/7z support coming soon.`);
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("unzip", ["-o", archivePath, "-d", extractDir]);
    proc.on("close", (code) => {
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`unzip exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  safeUnlink(archivePath);
  throwIfCancelled(jobId);

  const audioFiles = walkForAudio(extractDir).sort();
  if (audioFiles.length === 0) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error("No media files found in the archive (supported audio & video: mp3, mp4, flac, wav, ogg, m4a, aac, opus, wma, aiff, avi, mkv, mov, webm, flv, wmv, mpeg, 3gp, and more)");
  }

  const archiveName = new URL(url).pathname.split("/").pop()?.replace(/\.zip$/i, "") || "archive";

  await db.update(conversionsTable)
    .set({
      isPlaylist: true, itemCount: audioFiles.length,
      title: `${archiveName} (${audioFiles.length} tracks)`,
      statusLabel: `Converting ${audioFiles.length} audio files...`,
      progress: 25,
    })
    .where(eq(conversionsTable.id, jobId));

  const mp3Files: string[] = new Array(audioFiles.length).fill("");
  let completed = 0;
  let failed = 0;

  await runConcurrent(audioFiles, PLAYLIST_CONCURRENCY, async (audioFile, i) => {
    throwIfCancelled(jobId);
    const rel = audioFile.replace(extractDir + "/", "").replace(/\.[^.]+$/, "");
    const safeName = sanitizeFilename(`${String(i + 1).padStart(3, "0")}_${rel}`);
    const outputMp3 = join(UPLOADS_DIR, `${jobId}_af${i}_${safeName}.mp3`);

    if (existsSync(outputMp3)) {
      mp3Files[i] = outputMp3;
      completed++;
      return;
    }

    try {
      await convertToMp3(jobId, audioFile, outputMp3, job);
      throwIfCancelled(jobId);
      mp3Files[i] = outputMp3;
      completed++;
    } catch (err: any) {
      if (err?.message === "Cancelled" || activeJobs.get(jobId)?.cancelled) throw err;
      failed++;
      logger.warn({ jobId, audioFile, err: err?.message }, "Skipped archive audio track");
    }

    const done = completed + failed;
    const pct = Math.round(25 + (done / audioFiles.length) * 63);
    db.update(conversionsTable)
      .set({ statusLabel: `Converted ${completed}/${audioFiles.length}${failed > 0 ? ` (${failed} failed)` : ""}`, progress: pct })
      .where(eq(conversionsTable.id, jobId)).catch(() => {});
  });

  for (const f of audioFiles) safeUnlink(f);
  rmSync(extractDir, { recursive: true, force: true });
  throwIfCancelled(jobId);

  if (completed === 0) throw new Error(`All ${audioFiles.length} audio files failed to convert`);

  await db.update(conversionsTable)
    .set({ status: "zipping", statusLabel: "Creating ZIP archive...", progress: 90 })
    .where(eq(conversionsTable.id, jobId));

  const zipPath = join(UPLOADS_DIR, `${jobId}_archive_mp3.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 0 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    for (const mp3 of mp3Files) {
      if (mp3 && existsSync(mp3)) archive.file(mp3, { name: mp3.split("/").pop()! });
    }
    archive.finalize();
  });

  for (const mp3 of mp3Files) safeUnlink(mp3);

  const totalSize = (() => { try { return statSync(zipPath).size; } catch { return 0; } })();
  await db.update(conversionsTable)
    .set({
      status: "done",
      statusLabel: `Done — ${completed} tracks (${formatBytes(totalSize)})`,
      progress: 100, zipPath, fileSizeBytes: totalSize, completedAt: new Date(),
    })
    .where(eq(conversionsTable.id, jobId));
}

// ─── Concurrency helper ──────────────────────────────────────────────────────

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function runMultiUrlConversion(
  jobId: number,
  urls: string[],
  job: typeof conversionsTable.$inferSelect,
  downloadServer: string,
  audioLanguage: string,
): Promise<void> {
  const totalItems = urls.length;
  const initialTitle = `Multiple URLs (${totalItems} files)`;
  const [currentJob] = await db.select({ title: conversionsTable.title })
    .from(conversionsTable)
    .where(eq(conversionsTable.id, jobId));
  const requestedTitle = currentJob?.title || job.title;
  await db.update(conversionsTable)
    .set({
      isPlaylist: true,
      itemCount: totalItems,
      title: requestedTitle || initialTitle,
      statusLabel: `Preparing ${totalItems} URLs...`,
      progress: 0,
    })
    .where(eq(conversionsTable.id, jobId));

  const mp3Files: string[] = new Array(totalItems).fill("");
  let completed = 0;
  let failed = 0;

  await runConcurrent(urls, PLAYLIST_CONCURRENCY, async (sourceUrl, i) => {
    throwIfCancelled(jobId);
    let rawFile = "";
    try {
      const fetchedTitle = await withTrackTimeout(
        withRetry(() => fetchTitleSmart(sourceUrl), 2, 1500, sourceUrl),
        TRACK_TIMEOUT_MS,
        sourceUrl,
      );
      const fallbackName = (() => {
        try { return new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { return `file_${i + 1}`; }
      })();
      const trackTitle = fetchedTitle || fallbackName;
      const safeName = sanitizeFilename(`${String(i + 1).padStart(3, "0")}_${trackTitle}`);
      const rawTemplate = join(UPLOADS_DIR, `${jobId}_multi${i}_raw.%(ext)s`);
      const outputMp3 = join(UPLOADS_DIR, `${jobId}_multi${i}_${safeName}.mp3`);

      await withTrackTimeout(
        withRetry(async () => {
          rawFile = await downloadSingleSmart(
            jobId,
            sourceUrl,
            rawTemplate,
            downloadServer,
            undefined,
            { skipStreaming: true, audioLanguage },
          );
          throwIfCancelled(jobId);
          await convertToMp3(jobId, rawFile, outputMp3, job);
          safeUnlink(rawFile);
          rawFile = "";
        }, 2, 2000, trackTitle),
        TRACK_TIMEOUT_MS,
        trackTitle,
      );
      mp3Files[i] = outputMp3;
      completed++;
    } catch (err: any) {
      if (err?.message === "Cancelled" || activeJobs.get(jobId)?.cancelled) throw err;
      safeUnlink(rawFile);
      failed++;
      logger.warn({ jobId, url: sourceUrl, err: err?.message }, "Skipped multi-URL item");
    }

    const processed = completed + failed;
    const label = failed > 0
      ? `Processed ${completed}/${totalItems} (${failed} failed)`
      : `Processed ${completed}/${totalItems} URLs`;
    await db.update(conversionsTable)
      .set({ statusLabel: label, progress: Math.round((processed / totalItems) * 88) })
      .where(eq(conversionsTable.id, jobId))
      .catch(() => {});
  });

  throwIfCancelled(jobId);
  if (completed === 0) {
    throw new Error(`All ${totalItems} URLs failed to download`);
  }

  await db.update(conversionsTable)
    .set({ status: "zipping", statusLabel: "Creating ZIP archive...", progress: 90 })
    .where(eq(conversionsTable.id, jobId));

  const zipPath = join(UPLOADS_DIR, `${jobId}_multiple_urls.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 0 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const mp3 of mp3Files) {
      if (mp3 && existsSync(mp3)) archive.file(mp3, { name: mp3.split("/").pop()! });
    }
    archive.finalize().catch(reject);
  });

  for (const mp3 of mp3Files) safeUnlink(mp3);
  const totalSize = (() => { try { return statSync(zipPath).size; } catch { return 0; } })();
  const [finalJob] = await db.select({ title: conversionsTable.title })
    .from(conversionsTable)
    .where(eq(conversionsTable.id, jobId));
  await db.update(conversionsTable)
    .set({
      status: "done",
      title: finalJob?.title || requestedTitle || initialTitle,
      statusLabel: `Done — ${completed} of ${totalItems} files (${formatBytes(totalSize)})`,
      progress: 100,
      zipPath,
      fileSizeBytes: totalSize,
      completedAt: new Date(),
    })
    .where(eq(conversionsTable.id, jobId));
}

// ─── Main conversion runner ──────────────────────────────────────────────────

async function runConversionNow(jobId: number, downloadServer = "auto", audioLanguage = "original") {
  const existingJob = activeJobs.get(jobId);
  if (!existingJob) {
    activeJobs.set(jobId, { procs: new Set(), aborters: new Set(), cancelled: false });
  }
  const [job] = await db.select().from(conversionsTable).where(eq(conversionsTable.id, jobId));
  if (!job) {
    activeJobs.delete(jobId);
    return;
  }

  try {
    throwIfCancelled(jobId);
    await db.update(conversionsTable)
      .set({ status: "downloading", statusLabel: "Checking URL...", progress: 0 })
      .where(eq(conversionsTable.id, jobId));

    throwIfCancelled(jobId);

    const multiUrls = Array.isArray(job.sourceUrls) && job.sourceUrls.length > 1
      ? job.sourceUrls
      : null;
    if (multiUrls) {
      await runMultiUrlConversion(jobId, multiUrls, job, downloadServer, audioLanguage);
      logger.info({ jobId, count: multiUrls.length }, "Multi-URL conversion complete");
      return;
    }

    // ── Archive URL: download, extract audio, convert, re-zip ─────────────
    if (isArchiveUrl(job.youtubeUrl)) {
      await runArchiveConversion(jobId, job.youtubeUrl, job);
      logger.info({ jobId }, "Archive conversion complete");
      return;
    }

    const playlistMeta = await detectPlaylistEntriesSmart(job.youtubeUrl);
    const isPlaylist = playlistMeta !== null && playlistMeta.entries.length > 1;
    throwIfCancelled(jobId);

    if (isPlaylist && playlistMeta) {
      const { entries, name: playlistName } = playlistMeta;
      // ── Playlist mode ────────────────────────────────────────────────────
      const selectedRaw = job.selectedItems;
      const selected = Array.isArray(selectedRaw) && selectedRaw.length > 0
        ? entries.map((e, i) => ({ entry: e, originalIndex: i })).filter(x => selectedRaw.includes(x.originalIndex))
        : entries.map((e, i) => ({ entry: e, originalIndex: i }));

      const totalItems = selected.length;
      const resolvedTitle = playlistName || deriveNameFromUrl(job.youtubeUrl) || `Playlist (${totalItems} tracks)`;
      await db.update(conversionsTable)
        .set({ isPlaylist: true, itemCount: totalItems, statusLabel: `Playlist: ${totalItems} tracks`, title: (await db.select({ title: conversionsTable.title }).from(conversionsTable).where(eq(conversionsTable.id, jobId)))[0]?.title || resolvedTitle, progress: 0 })
        .where(eq(conversionsTable.id, jobId));

      const mp3Files: string[] = new Array(totalItems).fill("");
      let completed = 0;
      let failed = 0;

      await runConcurrent(selected, PLAYLIST_CONCURRENCY, async (item, i) => {
        throwIfCancelled(jobId);

        const trackTitle = item.entry.title || `track_${i + 1}`;
        const safeName = sanitizeFilename(`${String(i + 1).padStart(3, "0")}_${trackTitle}`);
        const outputMp3 = join(UPLOADS_DIR, `${jobId}_${safeName}.mp3`);

        // ── Resume: skip tracks already converted (e.g. after server restart) ──
        if (existsSync(outputMp3)) {
          logger.info({ jobId, track: trackTitle }, "Resuming: track already done, skipping");
          mp3Files[i] = outputMp3;
          completed++;
          const pct = Math.round((completed + failed) / totalItems * 88);
          db.update(conversionsTable)
            .set({ statusLabel: `Processed ${completed}/${totalItems} tracks`, progress: pct })
            .where(eq(conversionsTable.id, jobId)).catch(() => {});
          return;
        }

        // Fast path: Piped streaming for YouTube tracks (no temp file), with timeout + retry
        // Skip Piped when a non-original audio language is requested (Piped doesn't expose language-tagged tracks)
        const ytTrackId = extractYouTubeId(item.entry.url);
        let trackDone = false;
        const useLanguageFilter = audioLanguage && audioLanguage !== "original";

        const usePipedForTrack = ytTrackId && !audioLanguage && !useLanguageFilter && downloadServer !== "direct" && !(downloadServer in PLAYER_CLIENT_ARGS);
        if (usePipedForTrack) {
          try {
            await withRetry(() => withTrackTimeout(
              (async () => {
                const pv = await fetchPipedVideo(ytTrackId);
                throwIfCancelled(jobId);
                const audio = pickBestAudio(pv.audioStreams);
                await pipePipedStreamToMp3(jobId, audio.url, pv.duration, outputMp3, job);
                throwIfCancelled(jobId);
                mp3Files[i] = outputMp3;
                completed++;
                trackDone = true;
              })(),
              TRACK_TIMEOUT_MS,
              trackTitle,
            ), 1, 1000, trackTitle);
          } catch (e: any) {
            if (e?.message === "Cancelled" || activeJobs.get(jobId)?.cancelled) throw e;
            logger.warn({ jobId, track: trackTitle, err: e?.message }, "Piped streaming failed for track, falling back to yt-dlp");
          }
        }

        if (!trackDone) {
          const rawTemplate = join(UPLOADS_DIR, `${jobId}_item${i}_raw.%(ext)s`);
          let rawFile = "";
          try {
            await withTrackTimeout(
              withRetry(async () => {
                rawFile = await downloadSingleSmart(jobId, item.entry.url, rawTemplate, downloadServer, undefined, { skipStreaming: true, audioLanguage });
                throwIfCancelled(jobId);
                await convertToMp3(jobId, rawFile, outputMp3, job);
                safeUnlink(rawFile);
                throwIfCancelled(jobId);
                mp3Files[i] = outputMp3;
                completed++;
              }, 2, 2000, trackTitle),
              TRACK_TIMEOUT_MS,
              trackTitle,
            );
          } catch (err: any) {
            if (err?.message === "Cancelled" || activeJobs.get(jobId)?.cancelled) throw err;
            safeUnlink(rawFile);
            failed++;
            logger.warn({ jobId, track: item.entry.title, err: err?.message }, "Skipped playlist track");
          }
        }

        const done = completed + failed;
        const pct = Math.round((done / totalItems) * 88);
        const label = failed > 0
          ? `Processed ${completed}/${totalItems} (${failed} skipped)`
          : `Processed ${completed}/${totalItems} tracks`;
        db.update(conversionsTable)
          .set({ statusLabel: label, progress: pct })
          .where(eq(conversionsTable.id, jobId)).catch(() => {});
      });

      throwIfCancelled(jobId);

      if (completed === 0) {
        throw new Error(`All ${totalItems} tracks failed to download (likely paid/unavailable)`);
      }

      await db.update(conversionsTable)
        .set({ status: "zipping", statusLabel: "Creating ZIP archive...", progress: 90 })
        .where(eq(conversionsTable.id, jobId));

      const safePlaylistName = sanitizeFilename(resolvedTitle);
      const zipPath = join(UPLOADS_DIR, `${jobId}_${safePlaylistName}.zip`);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 0 } });
        output.on("close", resolve);
        archive.on("error", reject);
        archive.pipe(output);
        for (const mp3 of mp3Files) {
          if (mp3 && existsSync(mp3)) archive.file(mp3, { name: mp3.split("/").pop()! });
        }
        archive.finalize();
      });

      for (const mp3 of mp3Files) safeUnlink(mp3);

      const totalSize = (() => { try { return statSync(zipPath).size; } catch { return 0; } })();

      await db.update(conversionsTable)
        .set({ status: "done", statusLabel: `Done — ${mp3Files.filter(Boolean).length} tracks (${formatBytes(totalSize)})`, progress: 100, zipPath, fileSizeBytes: totalSize, completedAt: new Date() })
        .where(eq(conversionsTable.id, jobId));

    } else {
      // ── Single video mode ─────────────────────────────────────────────────
      const ytVideoId = extractYouTubeId(job.youtubeUrl);
      const useLanguageFilter = audioLanguage && audioLanguage !== "original";
      // Skip Piped when language filter is active — Piped doesn't expose language-tagged tracks
      const usePiped = ytVideoId && !audioLanguage && !useLanguageFilter && downloadServer !== "direct" && !(downloadServer in PLAYER_CLIENT_ARGS);
      if (usePiped) {
        try {
          const pipedVideo = await fetchPipedVideo(ytVideoId);
          throwIfCancelled(jobId);
          const title = pipedVideo.title || `audio_${jobId}`;
           const [currentJob] = await db.select({ title: conversionsTable.title })
             .from(conversionsTable)
             .where(eq(conversionsTable.id, jobId));
           const outputTitle = currentJob?.title || title;
          const audio = pickBestAudio(pipedVideo.audioStreams);
          await db.update(conversionsTable)
            .set({ title: outputTitle, status: "converting", statusLabel: "Streaming & converting...", progress: 5 })
            .where(eq(conversionsTable.id, jobId));
           const safeName = sanitizeFilename(outputTitle);
          const finalMp3 = join(UPLOADS_DIR, `${jobId}_${safeName}.mp3`);
          await pipePipedStreamToMp3(jobId, audio.url, pipedVideo.duration, finalMp3, job, (frac) => {
            db.update(conversionsTable)
              .set({ statusLabel: `Converting... ${Math.round(frac * 100)}%`, progress: Math.round(5 + frac * 93) })
              .where(eq(conversionsTable.id, jobId)).catch(() => {});
          });
          throwIfCancelled(jobId);
          const stat = statSync(finalMp3);
          await db.update(conversionsTable)
            .set({ status: "done", statusLabel: `Done (${formatBytes(stat.size)})`, progress: 100, outputPath: finalMp3, fileSizeBytes: stat.size, completedAt: new Date() })
            .where(eq(conversionsTable.id, jobId));
          logger.info({ jobId }, "Conversion complete (Piped streaming)");
          return;
        } catch (e: any) {
          if (e?.message === "Cancelled" || activeJobs.get(jobId)?.cancelled) throw e;
          logger.warn({ jobId, err: (e as Error).message }, "Piped streaming failed, falling back to yt-dlp");
        }
      }

      // Fallback / direct path: yt-dlp
      await db.update(conversionsTable)
        .set({ statusLabel: "Fetching video info..." })
        .where(eq(conversionsTable.id, jobId));

      const fetchedTitle = await fetchTitleSmart(job.youtubeUrl);
      throwIfCancelled(jobId);

      const rawTemplate = join(UPLOADS_DIR, `${jobId}_raw.%(ext)s`);

      const rawFile = await downloadSingleSmart(jobId, job.youtubeUrl, rawTemplate, downloadServer, (pct) => {
        db.update(conversionsTable)
          .set({ statusLabel: `Downloading... ${Math.round(pct)}%`, progress: Math.round(pct * 0.6) })
          .where(eq(conversionsTable.id, jobId)).catch(() => {});
      }, { audioLanguage });

      throwIfCancelled(jobId);
      const videoTitle = fetchedTitle || `audio_${jobId}`;
       const [currentJob] = await db.select({ title: conversionsTable.title })
         .from(conversionsTable)
         .where(eq(conversionsTable.id, jobId));
       const outputTitle = currentJob?.title || videoTitle;
      await db.update(conversionsTable)
         .set({ title: outputTitle, status: "converting", statusLabel: "Converting to MP3...", progress: 62 })
        .where(eq(conversionsTable.id, jobId));

       const safeName = sanitizeFilename(outputTitle);
      const finalMp3 = join(UPLOADS_DIR, `${jobId}_${safeName}.mp3`);

      await convertToMp3(jobId, rawFile, finalMp3, job, (frac) => {
        db.update(conversionsTable)
          .set({ statusLabel: `Converting... ${Math.round(frac * 100)}%`, progress: Math.round(62 + frac * 36) })
          .where(eq(conversionsTable.id, jobId)).catch(() => {});
      });

      safeUnlink(rawFile);
      throwIfCancelled(jobId);

      const stat = statSync(finalMp3);
      await db.update(conversionsTable)
        .set({ status: "done", statusLabel: `Done (${formatBytes(stat.size)})`, progress: 100, outputPath: finalMp3, fileSizeBytes: stat.size, completedAt: new Date() })
        .where(eq(conversionsTable.id, jobId));
    }

    logger.info({ jobId }, "Conversion complete");
  } catch (err: any) {
    const isCancelled = err?.message === "Cancelled" || activeJobs.get(jobId)?.cancelled;
    if (isCancelled) {
      logger.info({ jobId }, "Conversion cancelled");
      await db.update(conversionsTable)
        .set({ status: "cancelled", statusLabel: "Cancelled", completedAt: new Date() })
        .where(eq(conversionsTable.id, jobId)).catch(() => {});
      cleanJobFiles(jobId);
    } else {
      logger.error({ jobId, err: err?.message }, "Conversion failed");
      await db.update(conversionsTable)
        .set({ status: "error", statusLabel: "Error", error: err?.message ?? "Unknown error", completedAt: new Date() })
        .where(eq(conversionsTable.id, jobId)).catch(() => {});
    }
  } finally {
    activeJobs.delete(jobId);
  }
}

/**
 * YouTube playlist URLs enter a single FIFO queue. The lock wraps the whole
 * conversion process rather than individual tracks, so playlist A fully
 * finishes (including ZIP creation) before playlist B starts. Other jobs run
 * immediately and are not affected.
 */
export async function runConversion(jobId: number, downloadServer = "auto", audioLanguage = "original") {
  const [job] = await db
    .select({ youtubeUrl: conversionsTable.youtubeUrl, sourceUrls: conversionsTable.sourceUrls })
    .from(conversionsTable)
    .where(eq(conversionsTable.id, jobId));
  if (!job) return;

  if (!isYouTubePlaylistOperation(job)) {
    return runConversionNow(jobId, downloadServer, audioLanguage);
  }

  activeJobs.set(jobId, { procs: new Set(), aborters: new Set(), cancelled: false });
  await db.update(conversionsTable)
    .set({
      status: "pending",
      statusLabel: "Waiting for YouTube playlist queue...",
      progress: 0,
    })
    .where(eq(conversionsTable.id, jobId))
    .catch(() => {});

  return youtubePlaylistQueue.enqueue(jobId, () => runConversionNow(jobId, downloadServer, audioLanguage));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/disk-space", async (_req, res) => {
  try {
    const dfOut = execSync(`df -k "${UPLOADS_DIR}" 2>/dev/null || df -k /`).toString().trim();
    const lines = dfOut.split("\n");
    const parts = lines[lines.length - 1].split(/\s+/);
    const total = parseInt(parts[1] ?? "0") * 1024;
    const used = parseInt(parts[2] ?? "0") * 1024;
    const free = parseInt(parts[3] ?? "0") * 1024;
    let uploadsDirBytes = 0;
    try {
      for (const f of readdirSync(UPLOADS_DIR)) {
        try { uploadsDirBytes += statSync(join(UPLOADS_DIR, f)).size; } catch (_) {}
      }
    } catch (_) {}
    res.json({ freeBytes: free, totalBytes: total, usedBytes: used, uploadsDirBytes });
  } catch {
    res.json({ freeBytes: 0, totalBytes: 0, usedBytes: 0, uploadsDirBytes: 0 });
  }
});

router.get("/conversions", async (_req, res) => {
  const rows = await db.select().from(conversionsTable).orderBy(conversionsTable.createdAt);
  res.json(rows.reverse());
});

router.post("/conversions", async (req, res) => {
  const parsed = CreateConversionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const {
    youtubeUrl,
    sourceUrls,
    bitrate = 16,
    bitrateType = "abr",
    sampleRate = 8000,
    channels = 1,
    speed = 1.0,
    selectedItems,
  } = parsed.data as typeof parsed.data & { speed?: number; selectedItems?: number[] };

  const downloadServer = typeof req.body?.downloadServer === "string" ? req.body.downloadServer : "auto";
  const audioLanguage = typeof req.body?.audioLanguage === "string" ? req.body.audioLanguage : "original";
  const normalizedUrls = [...new Set(
    (Array.isArray(sourceUrls) ? sourceUrls : [youtubeUrl])
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter(Boolean),
  )];
  if (normalizedUrls.length === 0 || normalizedUrls.length > 50) {
    res.status(400).json({ error: "Provide between 1 and 50 valid URLs" });
    return;
  }
  for (const candidate of normalizedUrls) {
    try {
      const parsedUrl = new URL(candidate);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("unsupported protocol");
    } catch {
      res.status(400).json({ error: `Invalid URL: ${candidate}` });
      return;
    }
  }

  const [job] = await db.insert(conversionsTable).values({
    youtubeUrl: normalizedUrls[0], sourceUrls: normalizedUrls.length > 1 ? normalizedUrls : null,
    bitrate, bitrateType, sampleRate, channels, speed,
    selectedItems: Array.isArray(selectedItems) && selectedItems.length > 0 ? selectedItems : null,
  }).returning();
  res.status(201).json(job);

  setImmediate(() => {
    runConversion(job.id, downloadServer, audioLanguage).catch((err) => {
      logger.error({ jobId: job.id, err: err?.message }, "Unhandled conversion error");
    });
  });
});

router.patch("/conversions/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { title } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title (non-empty string) required" }); return;
  }
  const [updated] = await db
    .update(conversionsTable)
    .set({ title: title.trim() })
    .where(eq(conversionsTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.get("/playlist-info", async (req, res) => {
  const url = String(req.query.url ?? "").trim();
  if (!url) { res.status(400).json({ error: "url required" }); return; }

  // Serve recent cached scan instantly for repeated URLs
  const cached = playlistInfoCache.get(url);
  if (cached && Date.now() - cached.ts < PLAYLIST_INFO_CACHE_TTL_MS) {
    const meta = cached.meta;
    if (!meta || meta.entries.length <= 1) {
      res.json({ isPlaylist: false, entries: [] });
    } else {
      res.json({ isPlaylist: true, entries: meta.entries, name: meta.name ?? null });
    }
    return;
  }

  try {
    // 25-second hard timeout — prevents the Replit proxy from dropping the connection
    // on slow playlists (Archive.org, large YouTube playlists, etc.)
    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("playlist-info timeout")), 25_000)
    );
    const meta = await Promise.race([detectPlaylistEntriesSmart(url), timeoutPromise]);
    playlistInfoCache.set(url, { meta, ts: Date.now() });
    if (!meta || meta.entries.length <= 1) {
      res.json({ isPlaylist: false, entries: [] });
      return;
    }
    res.json({ isPlaylist: true, entries: meta.entries, name: meta.name ?? null });
  } catch (err: any) {
    playlistInfoCache.set(url, { meta: null, ts: Date.now() });
    res.json({ isPlaylist: false, entries: [] });
  }
});

// Bundle selected conversions into a ZIP
router.post("/conversions/bulk-download", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === "number") as number[] : [];
  if (ids.length === 0) { res.status(400).json({ error: "ids required" }); return; }

  const rows = await db.select().from(conversionsTable).where(inArray(conversionsTable.id, ids));
  const done = rows.filter(j => j.status === "done");
  const files: { src: string; name: string; sourceJob: typeof rows[0] }[] = [];
  for (const j of done) {
    const path = j.isPlaylist ? j.zipPath : j.outputPath;
    if (path && existsSync(path)) {
      const ext = j.isPlaylist ? ".zip" : ".mp3";
      const safe = sanitizeFilename(j.title ?? `audio_${j.id}`);
      files.push({ src: path, name: `${safe}${ext}`, sourceJob: j });
    }
  }
  if (files.length === 0) { res.status(404).json({ error: "No converted files available for the given ids" }); return; }

  const stamp = new Date().toISOString().slice(0, 10);
  const bundleTitle = `Bundle ${stamp} (${files.length} files)`;

  const [bundleJob] = await db.insert(conversionsTable).values({
    youtubeUrl: `bundle://${stamp}`,
    title: bundleTitle,
    status: "zipping",
    statusLabel: "Building archive...",
    progress: 0,
    isPlaylist: true,
    itemCount: files.length,
    bitrate: done[0]?.bitrate ?? 16,
    bitrateType: done[0]?.bitrateType ?? "abr",
    sampleRate: done[0]?.sampleRate ?? 8000,
    channels: done[0]?.channels ?? 1,
    speed: done[0]?.speed ?? 1.0,
  }).returning();

  const zipPath = join(UPLOADS_DIR, `${bundleJob.id}_bundle.zip`);

  try {
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);

      const seen = new Map<string, number>();
      for (const f of files) {
        let name = f.name;
        const count = seen.get(name) ?? 0;
        if (count > 0) {
          const dot = name.lastIndexOf(".");
          name = dot > 0 ? `${name.slice(0, dot)}_${count}${name.slice(dot)}` : `${name}_${count}`;
        }
        seen.set(f.name, count + 1);
        archive.file(f.src, { name });
      }
      archive.finalize();
    });

    const totalSize = (() => { try { return statSync(zipPath).size; } catch { return 0; } })();

    await db.update(conversionsTable)
      .set({
        status: "done",
        statusLabel: `Bundle of ${files.length} files (${formatBytes(totalSize)})`,
        progress: 100,
        zipPath,
        fileSizeBytes: totalSize,
        completedAt: new Date(),
      })
      .where(eq(conversionsTable.id, bundleJob.id));

    for (const f of files) {
      safeUnlink(f.src);
      cleanJobFiles(f.sourceJob.id);
    }
    await db.delete(conversionsTable).where(inArray(conversionsTable.id, files.map(f => f.sourceJob.id)));

    const [final] = await db.select().from(conversionsTable).where(eq(conversionsTable.id, bundleJob.id));
    res.json({ bundle: final, bundledCount: files.length });
  } catch (err: any) {
    logger.error({ err: err?.message }, "bulk-download failed");
    safeUnlink(zipPath);
    await db.delete(conversionsTable).where(eq(conversionsTable.id, bundleJob.id)).catch(() => {});
    res.status(500).json({ error: err?.message ?? "Bundle failed" });
  }
});

router.post("/conversions/:id/cancel", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  cancelJob(id);

  await db.update(conversionsTable)
    .set({ status: "cancelled", statusLabel: "Cancelled", completedAt: new Date() })
    .where(eq(conversionsTable.id, id));

  cleanJobFiles(id);
  res.json({ ok: true });
});

function deleteJobAssets(job: typeof conversionsTable.$inferSelect): void {
  if (job.outputPath) safeUnlink(job.outputPath);
  if (job.zipPath) safeUnlink(job.zipPath);
  cleanJobFiles(job.id);
}

router.delete("/conversions", async (req, res) => {
  const requestedIds = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).filter((x) => typeof x === "number") as number[]
    : null;

  for (const [jobId] of activeJobs.entries()) {
    if (requestedIds === null || requestedIds.includes(jobId)) cancelJob(jobId);
  }

  if (requestedIds === null || requestedIds.length === 0) {
    try {
      for (const f of readdirSync(UPLOADS_DIR)) {
        try { unlinkSync(join(UPLOADS_DIR, f)); } catch (_) {}
      }
    } catch (_) {}
    const all = await db.select().from(conversionsTable);
    if (all.length > 0) {
      await db.delete(conversionsTable).where(inArray(conversionsTable.id, all.map(j => j.id)));
    }
    res.json({ deleted: all.length });
    return;
  }

  const rows = await db.select().from(conversionsTable).where(inArray(conversionsTable.id, requestedIds));
  for (const job of rows) deleteJobAssets(job);
  if (rows.length > 0) {
    await db.delete(conversionsTable).where(inArray(conversionsTable.id, rows.map(j => j.id)));
  }
  res.json({ deleted: rows.length });
});

router.delete("/conversions/:id", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  cancelJob(id);
  const [job] = await db.select().from(conversionsTable).where(eq(conversionsTable.id, id));
  if (!job) { res.status(404).json({ error: "Not found" }); return; }
  deleteJobAssets(job);
  await db.delete(conversionsTable).where(eq(conversionsTable.id, id));
  res.json({ ok: true });
});

router.get("/conversions/:id", async (req, res) => {
  const parsed = GetConversionParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [job] = await db.select().from(conversionsTable).where(eq(conversionsTable.id, parsed.data.id));
  if (!job) { res.status(404).json({ error: "Not found" }); return; }
  res.json(job);
});

router.get("/conversions/:id/download", async (req, res) => {
  const parsed = DownloadConversionParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [job] = await db.select().from(conversionsTable).where(eq(conversionsTable.id, parsed.data.id));
  if (!job || job.status !== "done") { res.status(404).json({ error: "File not found or not ready" }); return; }

  if (job.isPlaylist && job.zipPath) {
    if (!existsSync(job.zipPath)) { res.status(404).json({ error: "ZIP file missing from disk" }); return; }
    const safeName = sanitizeFilename(job.title ?? `playlist_${job.id}`);
    res.setHeader("Content-Disposition", contentDisposition(`${safeName}.zip`));
    res.setHeader("Content-Type", "application/zip");
    res.sendFile(job.zipPath);
    return;
  }

  if (!job.outputPath || !existsSync(job.outputPath)) { res.status(404).json({ error: "File missing from disk" }); return; }

  const safeName = sanitizeFilename(job.title ?? `audio_${job.id}`);
  res.setHeader("Content-Disposition", contentDisposition(`${safeName}.mp3`));
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(job.outputPath);
});

export default router;
