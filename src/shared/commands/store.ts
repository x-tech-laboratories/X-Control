// The run commands: command lines this computer lets its paired devices run, such as locking the screen. They sync,
// keep a history, and export and import as JSON or CSV.

// ── Imports ──────────────────────────────────────────────────────────────────

import { write_csv_records, csv_records } from "@x-tech-laboratories/x-libs/csv";
import { asc, drizzle_of, eq, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { app_info } from "../plugins/manifests.ts";
import { id_of, json_file, text } from "../api_schemas.ts";
import { define_feature, new_id } from "../feature.ts";
import { migrations } from "./migrations/index.ts";
import { commands } from "./schema.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Command {
  id: string;
  name: string;
  command: string;
  position: number;
}

export interface CommandDraft {
  // Left out for a new command.
  id?: string;
  name: string;
  command: string;
}

export type ExportFormat = "json" | "csv";

// What an import would do: the commands it adds, those already the same, and those that differ from the ones kept.
export interface ImportPreview {
  added: Command[];
  same: number;
  differing: { kept: Command; incoming: Command }[];
}

export interface ImportReport {
  added: number;
  replaced: number;
  kept: number;
}

const catalogue_kind = "commands";
const catalogue_version = 1;

// ── Reading files ────────────────────────────────────────────────────────────

function command_of(row: Record<string, unknown>, index: number): Command {
  const name = String(row.name ?? "").trim();
  const command = String(row.command ?? "").trim();
  if (!name || !command) throw new Error(`Row ${index + 1} needs a name and a command.`);
  const id = String(row.id ?? "").trim() || new_id();
  return { id, name, command, position: Number(row.position) || index };
}

// The commands a file holds, as X-Control's own JSON export or a CSV of the commands table; any other file is refused.
export function read_command_file(file: string): Command[] {
  const trimmed = file.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as { app?: unknown; kind?: unknown; version?: unknown; tables?: { commands?: unknown } };
    if (parsed.app !== app_info.id) throw new Error("This file was not made by X-Control.");
    if (parsed.kind !== catalogue_kind) throw new Error("This file holds no run commands.");
    if (typeof parsed.version !== "number" || parsed.version > catalogue_version) throw new Error("This file was made by a newer X-Control; update this one first.");
    const rows = parsed.tables?.commands;
    if (!Array.isArray(rows)) throw new Error("The file's commands table is missing.");
    return rows.map((row, index) => command_of(row as Record<string, unknown>, index));
  }
  return csv_records(trimmed).map((row, index) => command_of(row, index));
}

// ── Store ────────────────────────────────────────────────────────────────────

function list_commands(database: SqlDatabase): Command[] {
  return drizzle_of(database).select().from(commands).orderBy(asc(commands.position), asc(commands.name)).all();
}

function get_command(database: SqlDatabase, id: string): Command | null {
  return drizzle_of(database).select().from(commands).where(eq(commands.id, id)).get() ?? null;
}

function save_command(database: SqlDatabase, draft: CommandDraft): string {
  const name = draft.name.trim();
  const command = draft.command.trim();
  if (!name) throw new Error("A command needs a name.");
  if (!command) throw new Error("A command needs a command line.");
  const rows = drizzle_of(database);
  if (draft.id && get_command(database, draft.id)) {
    rows.update(commands).set({ name, command }).where(eq(commands.id, draft.id)).run();
    return draft.id;
  }
  const id = draft.id || new_id();
  const position = list_commands(database).reduce((highest, row) => Math.max(highest, row.position + 1), 0);
  rows.insert(commands).values({ id, name, command, position }).run();
  return id;
}

function preview(database: SqlDatabase, file: string): ImportPreview {
  const kept = new Map(list_commands(database).map((command) => [command.id, command]));
  const result: ImportPreview = { added: [], same: 0, differing: [] };
  for (const incoming of read_command_file(file)) {
    const existing = kept.get(incoming.id);
    if (!existing) result.added.push(incoming);
    else if (existing.name === incoming.name && existing.command === incoming.command) result.same++;
    else result.differing.push({ kept: existing, incoming });
  }
  return result;
}

export const commands_feature = define_feature({
  id: "commands",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables([commands]),
  methods: {
    list_commands,
    get_command,
    save_command,
    remove_command: (database: SqlDatabase, id: string): void => void drizzle_of(database).delete(commands).where(eq(commands.id, id)).run(),
    // Swaps a command with the one before or after it.
    move_command: (database: SqlDatabase, id: string, step: number): void => {
      const all = list_commands(database);
      const index = all.findIndex((command) => command.id === id);
      const other = all[index + Math.sign(step)];
      if (index < 0 || !other) return;
      in_transaction(database, () => {
        all.splice(index, 1);
        all.splice(index + Math.sign(step), 0, get_command(database, id)!);
        all.forEach((command, position) => drizzle_of(database).update(commands).set({ position }).where(eq(commands.id, command.id)).run());
      });
    },
    export_commands: (database: SqlDatabase, format: ExportFormat): string => {
      const rows = list_commands(database);
      if (format === "csv") return write_csv_records(["id", "name", "command", "position"], rows as unknown as Record<string, string | number>[]);
      return JSON.stringify({ app: app_info.id, kind: catalogue_kind, version: catalogue_version, exported_at: new Date().toISOString(), tables: { commands: rows } }, null, 2);
    },
    lookup_command_import: preview,
    // "theirs" replaces the commands that differ with the file's; "mine" keeps them. New ones are added either way.
    import_commands: (database: SqlDatabase, file: string, differing: "mine" | "theirs"): ImportReport => {
      const found = preview(database, file);
      const rows = drizzle_of(database);
      in_transaction(database, () => {
        for (const command of found.added) rows.insert(commands).values(command).run();
        if (differing === "theirs") for (const { incoming } of found.differing) rows.update(commands).set({ name: incoming.name, command: incoming.command }).where(eq(commands.id, incoming.id)).run();
      });
      return { added: found.added.length, replaced: differing === "theirs" ? found.differing.length : 0, kept: differing === "theirs" ? 0 : found.differing.length };
    },
  },
  api: {
    list_commands: { description: "The run commands this computer offers its paired devices, in their order: each its id, name, command line and position.", params: [] },
    get_command: { description: "One run command by its id, or null.", params: [{ name: "id", schema: id_of("command") }] },
    save_command: {
      description: "Adds a run command, or changes one when its id is given. Paired devices can run it on the computer the daemon runs on, as its user. Answers the command's id.",
      params: [
        {
          name: "command",
          schema: {
            type: "object",
            properties: { id: text("The command's id, to change it; left out for a new one."), name: text("What devices show, such as Lock screen."), command: text("The command line, run by sh, such as loginctl lock-session.") },
            required: ["name", "command"],
          },
        },
      ],
    },
    remove_command: { description: "Removes a run command; History can bring it back.", params: [{ name: "id", schema: id_of("command") }], destructive: true },
    move_command: { description: "Moves a run command one place earlier (-1) or later (1).", params: [{ name: "id", schema: id_of("command") }, { name: "step", schema: { type: "integer", enum: [-1, 1] } }] },
    export_commands: { description: "Every run command as one file's text: X-Control's JSON export, or CSV.", params: [{ name: "format", schema: { type: "string", enum: ["json", "csv"] } }] },
    lookup_command_import: { description: "What importing a JSON or CSV file of run commands would do, changing nothing: the commands it adds, how many are the same, and those that differ.", params: [{ name: "file", schema: json_file }] },
    import_commands: {
      description: "Imports run commands from a JSON or CSV file: new ones are added, and those that differ from the ones kept are replaced (theirs) or left as they are (mine).",
      params: [{ name: "file", schema: json_file }, { name: "differing", schema: { type: "string", enum: ["mine", "theirs"], description: "Which copy wins where a command differs." } }],
    },
  },
});
