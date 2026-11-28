// The desktop app's daemon: everything X-Control does without a window, being the devices it reaches over KDE Connect,
// the database, sync, backups, history and the MCP endpoint. The window reaches it over a Unix socket with the same
// calls a browser makes to the web server, and closing the window leaves it running.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import fastify, { type FastifyInstance } from "fastify";
import { Notifier } from "@x-tech-laboratories/x-libs/agent/desktop_notify";
import { keep_backing_up, type BackupSchedule } from "@x-tech-laboratories/x-libs/backups";
import { create_certificate_trust } from "@x-tech-laboratories/x-libs/certificates";
import { create_local_mcp } from "@x-tech-laboratories/x-libs/electron/mcp";
import { daemon_socket_path, DaemonRunningError, listen_on_socket } from "@x-tech-laboratories/x-libs/local_daemon";
import { load_plugin_folder } from "@x-tech-laboratories/x-libs/plugin_folder";
import { register_call_table } from "@x-tech-laboratories/x-libs/server/call_table";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { register_error_replies, register_lenient_json_body } from "@x-tech-laboratories/x-libs/server/replies";
import { sqlite_backups } from "@x-tech-laboratories/x-libs/server/sqlite_backups";
import { file_sync_storage } from "@x-tech-laboratories/x-libs/sync_file_storage";
import { create_sync_peer, sync_device_methods } from "@x-tech-laboratories/x-libs/sync_peer";
import { keep_listening_for_peers } from "@x-tech-laboratories/x-libs/sync_peer_listening";

import { control_backup_naming, read_schedule } from "../shared/backups.ts";
import { control_api } from "../shared/bridge.ts";
import { read_desktop_settings, type DaemonMethods, type DesktopSettings } from "../shared/desktop.ts";
import { app_link } from "../shared/links.ts";
import { mcp_instructions } from "../shared/mcp.ts";
import { is_read_only, type SyncAndBackupMethods } from "../shared/page_api.ts";
import { needs_upgrade, open_store, sync_engine } from "../shared/store.ts";
import { bind_methods, dispatch, register_control_calls } from "../server/calls.ts";
import { default_downloads_folder, start_control } from "../server/control.ts";
import type { ControlPluginApi } from "../server/plugins/api.ts";
import { linux_services } from "../server/system/linux.ts";

// ── Profile ──────────────────────────────────────────────────────────────────

// The window starts it with these set; a run on another database has a socket of its own.
const database_path = process.env.X_CONTROL_DB;
if (!database_path) {
  console.error("x-control daemon: X_CONTROL_DB must name the database");
  process.exit(2);
}
const socket_path = process.env.X_CONTROL_SOCKET || daemon_socket_path({ app: "x-control", data_file: database_path });
const version = process.env.X_CONTROL_VERSION || "0.0.0";
// The built daemon sits in out/main, and resources/ beside out/ both in the source tree and in the package.
const icon_path = process.env.X_CONTROL_ICON || join(import.meta.dirname, "../../resources/icon.png");
// A dev run keeps off the network's usual ports, so it never meets the user's own KDE Connect devices.
const is_dev_profile = process.env.X_CONTROL_DEV === "1";

const profile = dirname(database_path);
const backups_folder = join(profile, "backups");

// How long the daemon waits after its last window closed before it stops, when it is not to keep running in the background.
const unused_exit_ms = 30_000;
const unused_check_ms = 5000;

// ── Database ─────────────────────────────────────────────────────────────────

function open_database(): DatabaseSync {
  const opened = new DatabaseSync(database_path!);
  opened.exec("PRAGMA journal_mode = WAL");
  return opened;
}

mkdirSync(profile, { recursive: true });
let database = open_database();

// Every window's event stream, told when the data or a device changed, or sync's status moved.
const changes = new EventStream();
const announce_change = (): void => changes.announce_change();

// ── Backups ──────────────────────────────────────────────────────────────────

const kept = sqlite_backups({
  folder: () => {
    mkdirSync(backups_folder, { recursive: true });
    return backups_folder;
  },
  naming: control_backup_naming,
  database: () => database,
  database_path: () => database_path,
  close: () => database.close(),
  open: () => {
    database = open_database();
    open_store(database);
  },
  after_restore: (restored) => sync_engine.forget_history(restored),
});

if (needs_upgrade(database)) await kept.create();
open_store(database);

// The schedule belongs to this device, so it is kept beside the database rather than in the synced settings.
const schedule_file = join(profile, "backup-schedule.json");

function read_backup_schedule(): BackupSchedule {
  return read_schedule(existsSync(schedule_file) ? JSON.parse(readFileSync(schedule_file, "utf8")) : null);
}

const backing_up = keep_backing_up(kept, read_backup_schedule);

// ── Sync ─────────────────────────────────────────────────────────────────────

// Certificates the user trusted for a paired device's https address, such as a home server's self-signed one, handed to Node's own fetch.
const certificates = create_certificate_trust({ file: join(profile, "trusted-certificates.json"), use_in_node: true });

// "Let other devices connect", off until the user turns it on, so paired daemons can reach this computer without a server.
const listening = keep_listening_for_peers({ peer: () => sync, app: "x-control", file: join(profile, "sync-listening.json"), default_port: 3933 });

const sync = create_sync_peer({
  app: "x-control",
  engine: sync_engine,
  database: () => database,
  storage: file_sync_storage({ file: join(profile, "sync-peers.json"), back_up_before_replace: async () => void (await kept.create()) }),
  device_name: `X-Control on ${hostname()}`,
  addresses: () => listening.addresses(),
  on_remote_change: announce_change,
  on_status: (status) => changes.send(JSON.stringify(status), { event: "sync_status" }),
});

// ── Devices ──────────────────────────────────────────────────────────────────

const notifier = new Notifier({ app_name: "X-Control", icons: { app: icon_path }, on_error: (message) => console.error(message) });
const folder = await load_plugin_folder<ControlPluginApi>(join(profile, "plugins"), "server");
for (const problem of folder.problems) console.warn(`plugin ${problem.name}: ${problem.problem}`);

const control = await start_control({
  database: () => database,
  identity_file: join(profile, "identity.json"),
  downloads_folder: default_downloads_folder(homedir(), profile),
  mounts_folder: join(process.env.XDG_RUNTIME_DIR || profile, "x-control", "mounts"),
  system: linux_services(),
  notify: (notice) => void notifier.show({ title: notice.title, body: notice.body, urgency: notice.urgency ?? "normal", key: notice.key, icon: "app", url: notice.route ? app_link(notice.route) : null }),
  withdraw: (key) => void notifier.dismiss({ key }),
  on_change: announce_change,
  network: is_dev_profile ? { discovery: false, tcp_ports: { lowest: 41791, highest: 41799 } } : {},
  folder_plugins: folder.plugins,
});

// ── MCP ──────────────────────────────────────────────────────────────────────

// Off until turned on in Settings; a change made through it reaches the open window like any other.
const local_mcp = create_local_mcp({
  name: "x-control",
  version,
  instructions: mcp_instructions,
  api: control_api,
  is_read_only,
  settings_file: join(profile, "mcp.json"),
  default_port: 3923,
  call: (method, args) => dispatch(bind_methods(() => database, control, announce_change), method, args),
});

// ── Desktop settings ─────────────────────────────────────────────────────────

const desktop_file = join(profile, "desktop.json");

function read_desktop(): DesktopSettings {
  return read_desktop_settings(existsSync(desktop_file) ? JSON.parse(readFileSync(desktop_file, "utf8")) : null);
}

// ── Calls ────────────────────────────────────────────────────────────────────

function device_methods(): SyncAndBackupMethods {
  return {
    ...sync_device_methods(sync),
    list_backups: kept.list,
    create_backup: () => kept.create(),
    // The restored copy then reaches every paired device, which backs itself up first.
    restore_backup: async (name) => {
      await kept.restore(name);
    },
    remove_backup: kept.remove,
    get_backup_schedule: read_backup_schedule,
    set_backup_schedule: (schedule) => {
      writeFileSync(schedule_file, JSON.stringify(read_schedule(schedule), null, 2));
      void backing_up.check();
    },
  };
}

function daemon_methods(shut_down: () => void): DaemonMethods {
  return {
    get_desktop_settings: read_desktop,
    set_desktop_setting: (key, value) => writeFileSync(desktop_file, JSON.stringify(read_desktop_settings({ ...read_desktop(), [key]: value }), null, 2)),
    // Stops once the answer has gone back.
    stop_daemon: () => void setTimeout(shut_down, 0),
  };
}

async function build_daemon(shut_down: () => void): Promise<FastifyInstance> {
  const daemon = fastify({ bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true });
  register_lenient_json_body(daemon);
  register_error_replies(daemon);
  // A change from one window reaches the others; the one that made it already shows it.
  const tell_others = (client_id: string): void => changes.announce_change(client_id);
  await daemon.register(
    async (api) => {
      changes.register(api, "/events");
      register_control_calls(api, () => database, control, changes);
      register_call_table(api, "/device", device_methods(), { is_read_only, on_change: tell_others });
      register_call_table(api, "/certificates", certificates.methods, { is_read_only });
      register_call_table(api, "/listening", listening.methods, { is_read_only });
      register_call_table(api, "/local_mcp", local_mcp.methods, { is_read_only });
      register_call_table(api, "/daemon", daemon_methods(shut_down), { is_read_only, on_change: tell_others });
    },
    { prefix: "/api" },
  );
  return daemon;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let is_stopping = false;
  let unused_timer: ReturnType<typeof setInterval> | undefined;
  const daemon = await build_daemon(() => shut_down());

  function shut_down(): void {
    if (is_stopping) return;
    is_stopping = true;
    clearInterval(unused_timer);
    sync.stop();
    void listening.stop();
    backing_up.stop();
    void control
      .stop()
      .then(() => daemon.close())
      .then(() => local_mcp.stop())
      .finally(() => {
        database.close();
        process.exit(0);
      });
  }

  try {
    await listen_on_socket(socket_path, (path) => daemon.listen({ path }));
  } catch (error) {
    // Another daemon on this database got there first, which is all that was asked for.
    if (error instanceof DaemonRunningError) {
      await control.stop();
      process.exit(0);
    }
    throw error;
  }
  console.log(`x-control daemon on ${socket_path}, using ${database_path}`);

  await listening.start();
  sync.start();
  void local_mcp.start();

  // Without "Keep running in the background", the daemon stops a while after its last window has gone.
  let unused_since = Date.now();
  unused_timer = setInterval(() => {
    if (changes.client_count > 0 || read_desktop().keep_running_in_background) unused_since = Date.now();
    else if (Date.now() - unused_since >= unused_exit_ms) shut_down();
  }, unused_check_ms);

  process.on("SIGINT", shut_down);
  process.on("SIGTERM", shut_down);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
