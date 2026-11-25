// The run commands' table, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { integer, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// A command line this computer lets its paired devices run, such as "loginctl lock-session".
export const commands = sqliteTable("commands", {
  id: text().primaryKey(),
  name: text().notNull(),
  command: text().notNull(),
  position: integer().notNull().default(0),
});
