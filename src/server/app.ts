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
import { register_sync_routes } from "@x-tech-laboratories/x-libs/server/sync_routes";
import { register_web_folder } from "@x-tech-laboratories/x-libs/server/web_folder";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

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
}

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: AppOptions): Promise<FastifyInstance> {
  const app = fastify({ forceCloseConnections: true });
  register_lenient_json_body(app);
  register_error_replies(app);
  const accounts = new AccountStore({ database: options.database, app_name: "X-Control", declared: options.declared, token_prefix: "xc" });
  // Backups reach the whole database, the accounts included, so only an admin may manage them.
  await register_accounts(app, { accounts, cookie_name: "x_control_session", read_only_paths: ["/api/mcp"], needed: (_method, path) => (path.startsWith("/api/backup/") ? { role: accounts.top_role } : "any") });

  const changes = options.changes ?? new EventStream();
  const database = () => options.database;

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
      register_sync_routes(api, {
        engine: sync_engine,
        database,
        back_up: async () => void (await options.backups.create_backup()),
        on_change: (request) => changes.announce_change(changes.client_id_of(request)),
      });
      if (options.plugins_folder) register_plugin_files(api, { folder: options.plugins_folder, prefix: "/plugins", side: "web" });
    },
    { prefix: "/api" },
  );

  await register_web_folder(app, { folder: options.web_folder });
  return app;
}
