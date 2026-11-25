// The paired devices' table, from which drizzle-kit writes the migrations and the store reads its row types. It never
// syncs: each daemon has its own certificate, so a phone pairs with each daemon on its own.

// ── Imports ──────────────────────────────────────────────────────────────────

import { sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

export const paired_devices = sqliteTable("paired_devices", {
  id: text().primaryKey(),
  name: text().notNull(),
  type: text().notNull(),
  // The PEM certificate it showed when it was paired, which it must show again.
  certificate: text().notNull(),
  paired_at: text().notNull(),
  last_address: text(),
  last_seen: text(),
});
