// The one database a daemon keeps: every feature's tables brought up to date, sync set to stamp every change, and
// every feature's calls in one table.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";
import { migrate, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";
import { create_sync_engine } from "@x-tech-laboratories/x-libs/sync_engine";

import { commands_feature } from "./commands/store.ts";
import { devices_feature } from "./devices/store.ts";
import { command_history, history_feature, record_history } from "./history/store.ts";
import { is_read_only } from "./page_api.ts";
import { common_setting_defaults, hide_secret_settings, settings_feature } from "./settings.ts";

// ── Features ─────────────────────────────────────────────────────────────────

export const features = [settings_feature, devices_feature, commands_feature, history_feature];

export const sync_engine = create_sync_engine({ tables: features.flatMap((feature) => feature.tables), after_apply: (database) => command_history.forget_touched(database) });

// ── Opening ──────────────────────────────────────────────────────────────────

// Whether opening would change the schema of a database that already holds data, so it can be backed up first.
export function needs_upgrade(database: SqlDatabase): boolean {
  const has_versions = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_versions'").get() !== undefined;
  if (!has_versions) return false;
  const version_of = database.prepare("SELECT version FROM schema_versions WHERE owner = ?");
  return features.some((feature) => ((version_of.get(feature.id) as { version: number } | undefined)?.version ?? 0) < feature.migrations.length);
}

// Brings an open connection up to date and sets sync to stamp every change; run once each time the database opens.
export function open_store(database: SqlDatabase): void {
  database.exec("PRAGMA foreign_keys = ON");
  for (const feature of features) migrate(database, feature.migrations, { owner: feature.id });
  command_history.install(database);
  sync_engine.install(database);
}

// ── Calls ────────────────────────────────────────────────────────────────────

function get_settings(database: SqlDatabase): Record<string, unknown> {
  return hide_secret_settings({ ...common_setting_defaults, ...settings_feature.methods.get_settings(database) });
}

const all_methods = {
  ...settings_feature.methods,
  ...commands_feature.methods,
  ...history_feature.methods,
  // Every setting, the ones never set at their defaults, so a page needs no list of defaults of its own; secrets hidden.
  get_settings,
};

type Bound<Methods> = {
  [Name in keyof Methods]: Methods[Name] extends (database: SqlDatabase, ...args: infer Args) => infer Result ? (...args: Args) => Result : never;
};

// Every call on the database, as the page makes them, without the database.
export type StoreMethods = Bound<typeof all_methods>;

export const store_method_names = Object.keys(all_methods) as (keyof StoreMethods & string)[];

export const store_api = { ...settings_feature.api, ...commands_feature.api, ...history_feature.api } as ApiSpec<StoreMethods>;

// The calls run on the database given; after each write the history records what it touched and on_change tells the
// other pages and devices.
export function bind_store_methods(database: () => SqlDatabase, on_change: (method: string) => void): StoreMethods {
  const bound = store_method_names.map((name) => {
    const method = all_methods[name] as (database: SqlDatabase, ...args: unknown[]) => unknown;
    const call = (...args: unknown[]): unknown => {
      const result = method(database(), ...args);
      if (is_read_only(name)) return result;
      record_history(database(), Number(get_settings(database())["history.keep_days"]) || 180);
      on_change(name);
      return result;
    };
    return [name, call];
  });
  return Object.fromEntries(bound) as StoreMethods;
}
