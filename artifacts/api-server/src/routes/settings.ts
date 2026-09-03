import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { setCookiesEnabled } from "./conversions";

const router: IRouter = Router();

const ALLOWED_KEYS = new Set([
  "bitrate",
  "bitrateType",
  "sampleRate",
  "channels",
  "speed",
  "downloadServer",
  "cookiesEnabled",
  "audioLanguage",
]);

async function getAll(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settingsTable);
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

router.get("/settings", async (_req, res) => {
  try {
    const settings = await getAll();
    res.json(settings);
  } catch (err: any) {
    logger.error({ err: err?.message }, "Failed to get settings");
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.put("/settings", async (req, res) => {
  const body = req.body ?? {};
  const updates: { key: string; value: unknown }[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    updates.push({ key, value });
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No valid settings keys provided" });
    return;
  }

  try {
    for (const { key, value } of updates) {
      await db
        .insert(settingsTable)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value, updatedAt: new Date() },
        });
      // Apply in-memory side effects immediately
      if (key === "cookiesEnabled") {
        setCookiesEnabled(value !== false);
      }
    }
    const settings = await getAll();
    res.json(settings);
  } catch (err: any) {
    logger.error({ err: err?.message }, "Failed to save settings");
    res.status(500).json({ error: "Failed to save settings" });
  }
});

export default router;
