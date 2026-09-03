import { Router, type IRouter } from "express";
import { existsSync, statSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { COOKIES_FILE } from "./conversions";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function inspectCookies(): { configured: boolean; sizeBytes?: number; lineCount?: number; updatedAt?: string } {
  if (!existsSync(COOKIES_FILE)) return { configured: false };
  const stat = statSync(COOKIES_FILE);
  let lineCount = 0;
  try {
    const content = readFileSync(COOKIES_FILE, "utf-8");
    lineCount = content.split("\n").filter(l => l.trim() && !l.trim().startsWith("#")).length;
  } catch (_) {}
  return {
    configured: true,
    sizeBytes: stat.size,
    lineCount,
    updatedAt: stat.mtime.toISOString(),
  };
}

router.get("/cookies", (_req, res) => {
  res.json(inspectCookies());
});

router.post("/cookies", (req, res) => {
  const raw = typeof req.body?.cookies === "string" ? req.body.cookies.trim() : "";
  if (!raw) {
    res.status(400).json({ error: "cookies field required (paste contents of cookies.txt)" });
    return;
  }
  // Basic Netscape format sanity check: must contain at least one tab-separated line
  const meaningful = raw.split("\n").filter((l: string) => l.trim() && !l.trim().startsWith("#"));
  if (meaningful.length === 0 || !meaningful.some((l: string) => l.split("\t").length >= 6)) {
    res.status(400).json({ error: "Doesn't look like Netscape cookies.txt format. Each cookie line should have tab-separated fields." });
    return;
  }
  try {
    writeFileSync(COOKIES_FILE, raw.endsWith("\n") ? raw : raw + "\n", { mode: 0o600 });
    logger.info({ lines: meaningful.length }, "Cookies file saved");
    res.json(inspectCookies());
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to save cookies" });
  }
});

router.delete("/cookies", (_req, res) => {
  if (existsSync(COOKIES_FILE)) {
    try { unlinkSync(COOKIES_FILE); } catch (_) {}
  }
  res.json({ configured: false });
});

export default router;
