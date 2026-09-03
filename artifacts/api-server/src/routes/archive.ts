import { Router, type IRouter } from "express";
import { existsSync, readFileSync, writeFileSync, statSync, createReadStream, unlinkSync } from "fs";
import { join } from "path";
import https from "https";
import { db, conversionsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CREDS_FILE = join(process.cwd(), "ia-credentials.json");

interface IACredentials {
  access: string;
  secret: string;
}

function loadCredentials(): IACredentials | null {
  try {
    if (!existsSync(CREDS_FILE)) return null;
    const raw = readFileSync(CREDS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.access && parsed?.secret) return parsed as IACredentials;
    return null;
  } catch {
    return null;
  }
}

function saveCredentials(creds: IACredentials): void {
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

// ─── Background upload job tracking ─────────────────────────────────────────

interface ArchiveUploadJob {
  id: string;
  status: "uploading" | "done" | "error";
  total: number;
  completed: number;
  failed: number;
  /** Byte-level progress within the current uploading file (0–1) */
  currentFileFraction: number;
  results: Array<{ id: number; title: string; url: string; error?: string }>;
  iaPageUrl: string;
  identifier: string;
  error?: string;
  startedAt: number;
}

const uploadJobs = new Map<string, ArchiveUploadJob>();

function randomHex(n: number): string {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
}

// Clean up stale jobs (older than 1 hour)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of uploadJobs.entries()) {
    if (job.startedAt < cutoff) uploadJobs.delete(id);
  }
}, 5 * 60 * 1000);

// ─── Credentials routes ───────────────────────────────────────────────────────

router.get("/archive/credentials", (_req, res) => {
  const creds = loadCredentials();
  res.json({ configured: !!creds });
});

router.post("/archive/credentials", (req, res) => {
  const { access, secret } = req.body ?? {};
  if (!access || !secret) {
    res.status(400).json({ error: "access and secret are required" });
    return;
  }
  saveCredentials({ access: String(access).trim(), secret: String(secret).trim() });
  res.json({ configured: true });
});

router.delete("/archive/credentials", (_req, res) => {
  try {
    if (existsSync(CREDS_FILE)) unlinkSync(CREDS_FILE);
  } catch {}
  res.json({ configured: false });
});

// ─── Status poll ─────────────────────────────────────────────────────────────

router.get("/archive/status/:jobId", (req, res) => {
  const job = uploadJobs.get(req.params.jobId ?? "");
  if (!job) {
    res.status(404).json({ error: "Upload job not found" });
    return;
  }

  // Byte-level global percent:
  // Each completed file contributes (1 / total) to progress.
  // The current uploading file contributes (currentFileFraction / total).
  const doneFraction = (job.completed + job.failed) / job.total;
  const inFlightFraction = job.currentFileFraction / job.total;
  const percent = Math.min(99, Math.round((doneFraction + inFlightFraction) * 100));

  res.json({
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    percent: job.status === "done" ? 100 : percent,
    results: job.results,
    iaPageUrl: job.iaPageUrl,
    identifier: job.identifier,
    error: job.error,
  });
});

// ─── Upload helper ────────────────────────────────────────────────────────────

function uploadFileToIA(
  filePath: string,
  identifier: string,
  remoteFilename: string,
  title: string,
  creds: IACredentials,
  mimeType = "audio/mpeg",
  onProgress?: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stat = statSync(filePath);
    const totalBytes = stat.size;
    let bytesSent = 0;

    const req = https.request(
      {
        hostname: "s3.us.archive.org",
        path: `/${encodeURIComponent(identifier)}/${encodeURIComponent(remoteFilename)}`,
        method: "PUT",
        headers: {
          "Authorization": `LOW ${creds.access}:${creds.secret}`,
          "x-amz-auto-make-bucket": "1",
          "x-archive-meta-mediatype": "audio",
          // Archive.org reads header bytes as UTF-8; Node.js requires Latin-1 headers,
          // so we re-encode the UTF-8 bytes as Latin-1 (same trick used by the
          // official internetarchive Python library).
          "x-archive-meta-title": Buffer.from(title, "utf-8").toString("latin1"),
          "x-archive-meta-description": `Uploaded by yt-mp3-converter`,
          "x-archive-queue-derive": "0",
          "x-archive-size-hint": totalBytes.toString(),
          "Content-Type": mimeType,
          "Content-Length": totalBytes.toString(),
        },
      },
      (iaRes) => {
        let body = "";
        iaRes.on("data", (d: Buffer) => (body += d.toString()));
        iaRes.on("end", () => {
          if (iaRes.statusCode && iaRes.statusCode < 300) {
            onProgress?.(1);
            resolve(`https://archive.org/download/${identifier}/${encodeURIComponent(remoteFilename)}`);
          } else {
            reject(
              new Error(
                `Archive.org returned HTTP ${iaRes.statusCode}. ` +
                  (body.includes("<Message>")
                    ? body.match(/<Message>(.+?)<\/Message>/)?.[1] ?? body.slice(0, 200)
                    : body.slice(0, 200)),
              ),
            );
          }
        });
      },
    );

    req.on("error", reject);

    // Set a 20-minute timeout for very large files
    req.setTimeout(20 * 60 * 1000, () => {
      req.destroy(new Error("Upload timed out after 20 minutes"));
    });

    // Track byte-level progress
    const fileStream = createReadStream(filePath);
    fileStream.on("data", (chunk: Buffer) => {
      bytesSent += chunk.length;
      if (totalBytes > 0) {
        onProgress?.(bytesSent / totalBytes);
      }
    });
    fileStream.on("error", reject);
    fileStream.pipe(req);
  });
}

/** Sanitize a title for use as a remote filename — keeps spaces, removes illegal chars */
function safeRemoteName(title: string, ext: string): string {
  const clean = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "audio";
  return `${clean}${ext}`;
}

// ─── Upload route ─────────────────────────────────────────────────────────────

// POST /api/archive/upload  { ids: number[] }  — starts background job, returns jobId immediately
router.post("/archive/upload", async (req, res) => {
  const creds = loadCredentials();
  if (!creds) {
    res.status(401).json({
      error: "Archive.org credentials not configured. Add them in the Archive.org settings panel.",
    });
    return;
  }

  const ids: number[] = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).filter((x): x is number => typeof x === "number")
    : [];

  if (ids.length === 0) {
    res.status(400).json({ error: "ids required" });
    return;
  }

  const rows = await db.select().from(conversionsTable).where(inArray(conversionsTable.id, ids));
  const uploadable = rows.filter((j) => j.status === "done");

  if (uploadable.length === 0) {
    res.status(404).json({ error: "No completed conversions found for the given ids" });
    return;
  }

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const identifier = `yt-mp3-${date}-${randomHex(6)}`;
  // Note: Archive.org items typically take 2–5 minutes to become publicly visible after first upload.
  const iaPageUrl = `https://archive.org/details/${identifier}`;
  const jobId = `${date}-${randomHex(8)}`;

  const job: ArchiveUploadJob = {
    id: jobId,
    status: "uploading",
    total: uploadable.length,
    completed: 0,
    failed: 0,
    currentFileFraction: 0,
    results: [],
    iaPageUrl,
    identifier,
    startedAt: Date.now(),
  };
  uploadJobs.set(jobId, job);

  // Return immediately — upload runs in background
  res.json({ jobId, iaPageUrl, identifier, total: uploadable.length });

  // Background upload — wrapped in try/catch so an unexpected throw doesn't leak
  setImmediate(async () => {
    try {
      for (const uploadJob of uploadable) {
        job.currentFileFraction = 0;

        const filePath = uploadJob.isPlaylist ? uploadJob.zipPath : uploadJob.outputPath;
        if (!filePath || !existsSync(filePath)) {
          job.results.push({
            id: uploadJob.id,
            title: uploadJob.title ?? String(uploadJob.id),
            url: "",
            error: "File not found on disk",
          });
          job.failed++;
          continue;
        }

        const ext = uploadJob.isPlaylist ? ".zip" : ".mp3";
        const fileTitle = uploadJob.title ?? `audio_${uploadJob.id}`;
        const remoteFilename = safeRemoteName(fileTitle, ext);
        const mimeType = uploadJob.isPlaylist ? "application/zip" : "audio/mpeg";

        try {
          const url = await uploadFileToIA(
            filePath,
            identifier,
            remoteFilename,
            fileTitle,
            creds,
            mimeType,
            (fraction) => {
              job.currentFileFraction = fraction;
            },
          );
          job.results.push({ id: uploadJob.id, title: uploadJob.title ?? String(uploadJob.id), url });
          job.completed++;
          job.currentFileFraction = 1;
          logger.info({ jobId: uploadJob.id, identifier, url }, "Uploaded to Archive.org");
        } catch (err: any) {
          logger.error({ jobId: uploadJob.id, err: err?.message }, "IA upload failed");
          job.results.push({
            id: uploadJob.id,
            title: uploadJob.title ?? String(uploadJob.id),
            url: "",
            error: err?.message ?? "Upload failed",
          });
          job.failed++;
          job.currentFileFraction = 0;
        }
      }

      job.status = job.failed === job.total ? "error" : "done";
      job.currentFileFraction = 0;
      if (job.status === "error") {
        const firstErr = job.results.find((r) => r.error)?.error;
        job.error = firstErr ?? "All uploads failed";
      }
      logger.info(
        { jobId, identifier, completed: job.completed, failed: job.failed },
        "Archive.org upload batch complete",
      );
    } catch (outerErr: any) {
      // Safety net — prevents silent hang if something unexpected throws
      logger.error({ jobId, err: outerErr?.message }, "Unexpected error in Archive.org upload job");
      job.status = "error";
      job.error = outerErr?.message ?? "Unexpected upload error";
      job.currentFileFraction = 0;
    }
  });
});

export default router;
