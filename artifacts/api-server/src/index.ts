import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { conversionsTable, settingsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { runConversion, setCookiesEnabled } from "./routes/conversions";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function applySettings() {
  try {
    const rows = await db.select().from(settingsTable);
    for (const row of rows) {
      if (row.key === "cookiesEnabled") {
        setCookiesEnabled(row.value !== false);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load settings on startup");
  }
}

async function resumePendingJobs() {
  try {
    const stuckJobs = await db
      .select()
      .from(conversionsTable)
      .where(inArray(conversionsTable.status, ["pending", "downloading", "converting"]));

    if (stuckJobs.length > 0) {
      logger.info({ count: stuckJobs.length }, "Resuming interrupted conversion jobs");
      for (const job of stuckJobs) {
        await db
          .update(conversionsTable)
          .set({ status: "pending", statusLabel: "Queued...", progress: 0 })
          .where(inArray(conversionsTable.status, ["downloading", "converting"]));
        setImmediate(() => {
          runConversion(job.id).catch((err: unknown) => {
            logger.error({ jobId: job.id, err }, "Unhandled error resuming job");
          });
        });
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to resume pending jobs");
  }
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  applySettings();
  resumePendingJobs();
});

// Disable HTTP timeouts so long-running conversions and big playlist scans
// (which can stream/spawn for many minutes) are never cut off mid-flight.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120_000;
