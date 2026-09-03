import { pgTable, serial, text, integer, bigint, real, timestamp, pgEnum, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const conversionStatusEnum = pgEnum("conversion_status", [
  "pending",
  "downloading",
  "converting",
  "zipping",
  "done",
  "error",
  "cancelled",
]);

export const conversionsTable = pgTable("conversions", {
  id: serial("id").primaryKey(),
  youtubeUrl: text("youtube_url").notNull(),
  sourceUrls: jsonb("source_urls").$type<string[]>(),
  title: text("title"),
  status: conversionStatusEnum("status").notNull().default("pending"),
  statusLabel: text("status_label"),
  progress: real("progress"),
  bitrate: integer("bitrate").notNull().default(16),
  bitrateType: text("bitrate_type").notNull().default("abr"),
  sampleRate: integer("sample_rate").notNull().default(8000),
  channels: integer("channels").notNull().default(1),
  speed: real("speed").notNull().default(1.0),
  selectedItems: jsonb("selected_items").$type<number[]>(),
  isPlaylist: boolean("is_playlist").notNull().default(false),
  itemCount: integer("item_count"),
  outputPath: text("output_path"),
  zipPath: text("zip_path"),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  error: text("error"),
});

export const insertConversionSchema = createInsertSchema(conversionsTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  status: true,
  progress: true,
  statusLabel: true,
  outputPath: true,
  zipPath: true,
  fileSizeBytes: true,
  error: true,
  title: true,
  isPlaylist: true,
  itemCount: true,
});

export type InsertConversion = z.infer<typeof insertConversionSchema>;
export type Conversion = typeof conversionsTable.$inferSelect;
