// Starts the X-Control server on the config it is given: its database, its KDE Connect side and its web page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { keep_backing_up } from "@x-tech-laboratories/x-libs/backups";
import { load_plugin_folder } from "@x-tech-laboratories/x-libs/plugin_folder";
import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { read_channels } from "@x-tech-laboratories/x-libs/server/notify/channels";
import { load_accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";

import { control_backup_naming, read_schedule } from "../shared/backups.ts";
import { needs_upgrade, open_store, sync_engine } from "../shared/store.ts";
import { build_app } from "./app.ts";
import { read_config } from "./config.ts";
import { start_control } from "./control.ts";
import type { ControlPluginApi } from "./plugins/api.ts";
import { linux_services } from "./system/linux.ts";
import { sample_computer } from "./system/sample.ts";

// ── Config ───────────────────────────────────────────────────────────────────

const server_config = read_server_config({
  program: "x-control",
  summary: "Serves X-Control as a web app, reaches devices over KDE Connect and syncs its daemons.",
  env_prefix: "X_CONTROL",
  default_port: 7780,
  secret: false,
  web_folder_default: join(import.meta.dirname, "../../out/web"),
  options: { config: { variable: "X_CONTROL_CONFIG", help: "the JSON config naming the database and the KDE Connect settings", placeholder: "<file>", required: true } },
});

const config = read_config(JSON.parse(readFileSync(server_config.values.config!, "utf8")));

// ── Database ─────────────────────────────────────────────────────────────────

mkdirSync(dirname(config.database), { recursive: true });
// A backup restored from the page waits beside the database until the server starts again.
const restored = take_staged_restore(config.database);
const database = new DatabaseSync(config.database);
database.exec("PRAGMA journal_mode = WAL");

// ── Backups ──────────────────────────────────────────────────────────────────

const answer_delay_ms = 500;

// A restore is staged for the next start, then the server stops once the page has its answer, so its service starts
// it again on the backup.
const kept = sqlite_backups({
  folder: () => {
    mkdirSync(config.backups_folder, { recursive: true });
    return config.backups_folder;
  },
  naming: control_backup_naming,
  database: () => database,
  database_path: () => config.database,
  after_staging: () => void setTimeout(stop, answer_delay_ms),
});

if (needs_upgrade(database)) await kept.create();
open_store(database);
// The restored data is no longer what the devices last saw, so each chooses again which copy to keep.
if (restored) sync_engine.forget_history(database);

// The schedule belongs to this server, so it is kept beside the database rather than in the synced settings.
const schedule_file = join(dirname(config.database), "backup-schedule.json");
const read_backup_schedule = () => read_schedule(existsSync(schedule_file) ? JSON.parse(readFileSync(schedule_file, "utf8")) : null);
const backing_up = keep_backing_up(kept, read_backup_schedule);

// ── Devices ──────────────────────────────────────────────────────────────────

const channels = read_channels(config.notify_channels);
const changes = new EventStream();
const folder = await load_plugin_folder<ControlPluginApi>(config.plugins_folder, "server");
for (const problem of folder.problems) console.warn(`plugin ${problem.name}: ${problem.problem}`);

const control = await start_control({
  database: () => database,
  identity_file: config.identity_file,
  downloads_folder: config.downloads_folder,
  mounts_folder: config.mounts_folder,
  system: config.system === "sample" ? sample_computer() : linux_services(),
  // A server has no desktop, so its notices go out through the channels its config names.
  notify: (notice) => {
    for (const channel of channels) void channel({ title: notice.title, body: notice.body, level: notice.urgency === "critical" ? "warning" : "info" }).catch((error: unknown) => console.warn(`notify: ${(error as Error).message}`));
  },
  withdraw: () => {},
  on_change: () => changes.announce_change(),
  network: config.network,
  defaults: { name: config.device_name ?? undefined, type: config.device_type },
  folder_plugins: folder.plugins,
  home_assistant: config.home_assistant,
  system_bridge: config.system_bridge,
});

// ── Server ───────────────────────────────────────────────────────────────────

const app = await build_app({
  database,
  control,
  changes,
  declared: load_accounts("X_CONTROL_PASSWORD_HASH_FILE"),
  web_folder: server_config.web_folder,
  plugins_folder: config.plugins_folder,
  backups: {
    list_backups: kept.list,
    create_backup: () => kept.create(),
    restore_backup: kept.restore,
    remove_backup: kept.remove,
    get_backup_schedule: read_backup_schedule,
    set_backup_schedule: (schedule) => {
      writeFileSync(schedule_file, JSON.stringify(read_schedule(schedule), null, 2));
      void backing_up.check();
    },
  },
});
await app.listen({ host: server_config.host, port: server_config.port });
console.info(`X-Control is serving http://${server_config.host}:${server_config.port}/`);

function stop(): void {
  backing_up.stop();
  void control
    .stop()
    .then(() => app.close())
    .then(() => database.close());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
