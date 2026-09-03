import { logger } from "./logger";
import { getApiHeaders } from "./useragents";

// Invidious API instances — live-tested from this server's network (2026-05-30).
// Only confirmed-200 instances on /api/v1/videos/:id are listed.
const DEFAULT_INSTANCES: string[] = [];
// All previously-listed instances returned "Invidious has shutdown".
// yt-dlp is now the primary path for all downloads.

let instanceOrder: string[] = [...DEFAULT_INSTANCES];

function promoteInstance(url: string): void {
  instanceOrder = [url, ...instanceOrder.filter((i) => i !== url)];
}

async function invGet<T>(path: string, timeoutMs = 15000): Promise<T> {
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
      logger.debug({ instance, path, err: (e as Error).message }, "Invidious instance failed");
    }
  }
  throw new Error(`All Invidious instances unavailable: ${(lastErr as Error)?.message ?? lastErr}`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InvidiousAudioStream {
  url: string;
  type: string;        // e.g. "audio/webm; codecs=\"opus\""
  bitrate: number;     // bits per second
  audioQuality: string;
  audioSampleRate: number;
  audioChannels: number;
}

export interface InvidiousVideo {
  title: string;
  lengthSeconds: number;
  audioStreams: InvidiousAudioStream[];
}

interface RawInvidiousVideo {
  title?: string;
  lengthSeconds?: number;
  adaptiveFormats?: Array<{
    type?: string;
    bitrate?: number;
    url?: string;
    audioQuality?: string;
    audioSampleRate?: number;
    audioChannels?: number;
  }>;
}

export async function fetchInvidiousVideo(videoId: string): Promise<InvidiousVideo> {
  const raw = await invGet<RawInvidiousVideo>(
    `/api/v1/videos/${encodeURIComponent(videoId)}?fields=title,lengthSeconds,adaptiveFormats`,
  );

  const audioStreams: InvidiousAudioStream[] = (raw.adaptiveFormats ?? [])
    .filter((f) => f.type?.startsWith("audio/") && f.url)
    .map((f) => ({
      url: f.url!,
      type: f.type ?? "audio/webm",
      bitrate: f.bitrate ?? 0,
      audioQuality: f.audioQuality ?? "",
      audioSampleRate: f.audioSampleRate ?? 48000,
      audioChannels: f.audioChannels ?? 2,
    }));

  if (audioStreams.length === 0) {
    throw new Error("Invidious: no audio streams (video may be private/geo-restricted)");
  }

  return {
    title: raw.title ?? "",
    lengthSeconds: raw.lengthSeconds ?? 0,
    audioStreams,
  };
}

export function pickBestInvidiousAudio(streams: InvidiousAudioStream[]): InvidiousAudioStream {
  // Prefer opus (webm container) at highest bitrate, else best m4a.
  const sorted = [...streams].sort((a, b) => b.bitrate - a.bitrate);
  return sorted.find((s) => s.type.includes("opus") || s.type.includes("webm")) ?? sorted[0];
}
