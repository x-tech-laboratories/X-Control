// What each part of X-Control, such as its run commands or its paired devices, brings to the one database a daemon
// keeps: its tables, which of them sync, and the calls the page makes on them.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";
import type { SettingSpec } from "@x-tech-laboratories/x-libs/settings";
import type { MigrationStep, SqlDatabase } from "@x-tech-laboratories/x-libs/sql";
import type { SyncedTable } from "@x-tech-laboratories/x-libs/sync_engine";

// ── Features ─────────────────────────────────────────────────────────────────

// A call runs where the database is: on the server or in the desktop app's daemon.
export type StoreMethod = (database: SqlDatabase, ...args: never[]) => unknown;

export interface Feature<Methods extends Record<string, StoreMethod>> {
  id: string;
  // Each step runs once, in order, such as drizzle-kit's bundled migrations; a released step is never edited, only followed by a new one.
  migrations: readonly MigrationStep[];
  // Parents before children; a table left out never leaves this device.
  tables: SyncedTable[];
  // Names that read start with list_, get_, search_, lookup_ or export_, so a write is the only call that announces a change.
  methods: Methods;
  // What each call does and takes, for programs that reach them through MCP or the API.
  api: ApiSpec<Methods>;
  // The settings this feature owns, by key such as "history.keep_days".
  settings?: Record<string, SettingSpec>;
}

export function define_feature<Methods extends Record<string, StoreMethod>>(feature: Feature<Methods>): Feature<Methods> {
  return feature;
}

// A new id that every device can make on its own without clashing.
export function new_id(): string {
  return crypto.randomUUID();
}
