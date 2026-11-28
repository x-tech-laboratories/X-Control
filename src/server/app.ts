// The web server: the page, every call the page makes, the API and MCP for other programs, and the sync other
// X-Control daemons run against, all on one database and one control core.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import fastify, { type FastifyInstance } from "fastify";
import { openapi_document } from "@x-tech-laboratories/x-libs/api_spec";
import type { BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import { register_accounts } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import { register_call_table } from "@x-tech-laboratories/x-libs/server/call_table";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { register_mcp_route } from "@x-tech-laboratories/x-libs/server/mcp";
import type { Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { register_plugin_files } from "@x-tech-laboratories/x-libs/server/plugin_files";
import { register_error_replies, register_lenient_json_body } from "@x-tech-laboratories/x-libs/server/replies";
import { register_sync_peer_routes } from "@x-tech-laboratories/x-libs/server/sync_peer_routes";
import { register_web_folder } from "@x-tech-laboratories/x-libs/server/web_folder";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";
import { create_sync_peer, sync_device_methods } from "@x-tech-laboratories/x-libs/sync_peer";
import type { PeerStorage } from "@x-tech-laboratories/x-libs/sync_protocol";

import { control_api } from "../shared/bridge.ts";
import { mcp_instructions as instructions } from "../shared/mcp.ts";
import { is_read_only } from "../shared/page_api.ts";
import { sync_engine } from "../shared/store.ts";
import { bind_methods, dispatch, register_control_calls } from "./calls.ts";
import type { Control } from "./control.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface AppOptions {
  database: SqlDatabase;
  control: Control;
  // The users from the accounts file, who are admins; others are added under Settings.
  declared: Accounts;
  web_folder: string;
  // The database's backups, which an admin manages from the page; one is taken before a device's data replaces it.
  backups: BackupMethods;
  // The plugins folder, whose page sides the page loads from /api/plugins/.
  plugins_folder?: string;
  // The event stream every page follows; the control core announces device changes on it too.
  changes?: EventStream;
  // This server's keys and paired devices, and the address they reach it at, such as "https://control.example.org/api/";
  // without them it syncs with no device.
  sync?: { storage: PeerStorage; address: string | null };
}

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: AppOptions): Promise<FastifyInstance> {
  const app = fastify({ forceCloseConnections: true });
  register_lenient_json_body(app);
  register_error_replies(app);
  const accounts = new AccountStore({ database: options.database, app_name: "X-Control", declared: options.declared, token_prefix: "xc" });
  // Backups reach the whole database, the accounts included, and pairing lets a device change all of it, so only an admin
  // may manage them; the sync route needs no sign-in, since every call to it is sealed by a paired device.
  await register_accounts(app, {
    accounts,
    cookie_name: "x_control_session",
    read_only_paths: ["/api/mcp"],
    open_paths: ["/api/sync/peer"],
    needed: (_method, path) => (path.startsWith("/api/backup/") || path.startsWith("/api/sync/") ? { role: accounts.top_role } : "any"),
  });

  const changes = options.changes ?? new EventStream();
  const database = () => options.database;
  const sync_options = options.sync;
  const sync = sync_options
    ? create_sync_peer({
        app: "x-control",
        engine: sync_engine,
        database,
        storage: sync_options.storage,
        device_name: "X-Control server",
        addresses: () => (sync_options.address ? [sync_options.address] : []),
        on_remote_change: () => changes.announce_change(),
      })
    : null;
  if (sync) {
    app.addHook("onReady", async () => sync.start());
    app.addHook("onClose", async () => sync.stop());
  }

  await app.register(
    async (api) => {
      changes.register(api, "/events");
      register_control_calls(api, database, options.control, changes);

      api.get("/openapi.json", async () => openapi_document(control_api, { title: "X-Control", version, description: instructions, path_of: (method) => `/api/call/${method}`, is_read_only }));

      // A change made through MCP is announced to every page, since no page made it.
      await register_mcp_route(api, {
        name: "x-control",
        version,
        instructions,
        api: control_api,
        is_read_only,
        call: (method, args) => dispatch(bind_methods(database, options.control, () => changes.announce_change()), method, args),
      });

      // Backup calls arrive as POST /api/backup/<method> with the arguments as a JSON list.
      register_call_table(api, "/backup", options.backups, { is_read_only });
      if (sync) {
        register_sync_peer_routes(api, sync);
        // The server's own pairing calls, which an admin makes from the page's Sync section.
        register_call_table(api, "/sync", sync_device_methods(sync), { is_read_only });
      }
      if (options.plugins_folder) register_plugin_files(api, { folder: options.plugins_folder, prefix: "/plugins", side: "web" });
    },
    { prefix: "/api" },
  );

  await register_web_folder(app, { folder: options.web_folder });
  return app;
}
