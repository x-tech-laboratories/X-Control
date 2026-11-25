// Every change to a run command kept as versions through X-Libs history: any version can be restored, and a deleted
// command brought back. The versions sync with the commands.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_history, type Version } from "@x-tech-laboratories/x-libs/history";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of } from "../api_schemas.ts";
import { define_feature } from "../feature.ts";

// ── Commands ─────────────────────────────────────────────────────────────────

export interface CommandSnapshot {
  id: string;
  name: string;
  command: string;
  position: number;
}

export type CommandVersion = Version<CommandSnapshot>;

const day_in_milliseconds = 24 * 60 * 60 * 1000;

export const command_history = create_history<CommandSnapshot>({
  name: "command",
  item_table: "commands",
  watches: [{ table: "commands", item_columns: ["id"] }],
  read: (database, id) => (database.prepare("SELECT id, name, command, position FROM commands WHERE id = ?").get(id) as CommandSnapshot | undefined) ?? null,
  apply: (database, id, snapshot) => {
    database.prepare("INSERT INTO commands (id, name, command, position) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, command = excluded.command, position = excluded.position").run(id, snapshot.name, snapshot.command, snapshot.position);
  },
});

// Writes the versions of what changed since the last call, and prunes those older than the setting allows.
export function record_history(database: SqlDatabase, keep_days: number): void {
  command_history.record(database);
  command_history.prune(database, new Date(Date.now() - keep_days * day_in_milliseconds).toISOString());
}

// ── Store ────────────────────────────────────────────────────────────────────

export const history_feature = define_feature({
  id: "history",
  migrations: [command_history.schema],
  tables: [command_history.synced_table],
  methods: {
    list_versions: (database: SqlDatabase, item_id: string) => command_history.read_versions(database, item_id),
    list_recent_versions: (database: SqlDatabase, limit: number) => command_history.read_recent(database, limit),
    restore_version: (database: SqlDatabase, version_id: string) => command_history.restore(database, version_id),
  },
  api: {
    list_versions: { description: "Every version of one run command, newest first, each with what it was before.", params: [{ name: "item_id", schema: id_of("command") }] },
    list_recent_versions: { description: "The latest changes to every run command, newest first.", params: [{ name: "limit", schema: { type: "integer", minimum: 1, maximum: 500, description: "How many to list." } }] },
    restore_version: { description: "Puts a run command back as one of its versions had it, bringing it back if it was deleted.", params: [{ name: "version_id", schema: id_of("version") }] },
  },
});
