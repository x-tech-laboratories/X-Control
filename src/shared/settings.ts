// Settings kept as JSON values by key, so each feature and plugin can add its own; those of one device, such as which
// notifications it shows, never sync. All of them export and import as one JSON file.

// ── Imports ──────────────────────────────────────────────────────────────────

import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { json_file, text } from "./api_schemas.ts";
import { define_feature } from "./feature.ts";
import { notice_setting_defaults } from "./notices.ts";
import { app_info, plugins_setting } from "./plugins/manifests.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export type Settings = Record<string, unknown>;

// The link to Home Assistant over MQTT, which each computer makes for itself.
export const home_assistant_setting_defaults: Settings = {
  "home_assistant.enabled": false,
  // Such as mqtt://homeassistant.local:1883.
  "home_assistant.broker": "",
  "home_assistant.username": "",
  "home_assistant.password": "",
  "home_assistant.discovery_prefix": "homeassistant",
  "home_assistant.base_topic": "x-control",
  // Seconds between readings.
  "home_assistant.interval": 10,
};

export const common_setting_defaults: Settings = {
  // How long History keeps versions of a run command, in days.
  "history.keep_days": 180,
  [plugins_setting]: {},
  ...notice_setting_defaults,
  ...home_assistant_setting_defaults,
};

// Settings that belong to one device: they never sync, and an export leaves them out.
export const device_setting_keys = [...Object.keys(notice_setting_defaults), ...Object.keys(home_assistant_setting_defaults)];

// Settings never given back to the page or other programs; they read a placeholder while one is set.
export const secret_setting_keys = ["home_assistant.password"];

// What a secret setting reads while one is set; writing it back leaves the secret as it was.
export const hidden_secret = "••••••••";

// The settings with each secret one set replaced by the placeholder.
export function hide_secret_settings(settings: Settings): Settings {
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, secret_setting_keys.includes(key) && typeof value === "string" && value !== "" ? hidden_secret : value]));
}

const settings_kind = "settings";
const settings_version = 1;

// ── Store ────────────────────────────────────────────────────────────────────

function get_stored(database: SqlDatabase): Settings {
  const rows = database.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
}

function set_setting(database: SqlDatabase, key: string, value: unknown): void {
  if (secret_setting_keys.includes(key) && value === hidden_secret) return;
  database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

export const settings_feature = define_feature({
  id: "settings",
  migrations: [`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`],
  tables: [{ name: "settings", key_columns: ["key"], local_keys: device_setting_keys }],
  methods: {
    // Only the values set; the store lays them over the defaults.
    get_settings: get_stored,
    set_setting,
    export_settings: (database: SqlDatabase): string => {
      const shared = Object.entries({ ...common_setting_defaults, ...get_stored(database) }).filter(([key]) => !device_setting_keys.includes(key));
      return JSON.stringify({ app: app_info.id, kind: settings_kind, version: settings_version, exported_at: new Date().toISOString(), settings: Object.fromEntries(shared) }, null, 2);
    },
    // Keys the app does not know, and those of one device, are left out; answers how many were set.
    import_settings: (database: SqlDatabase, file: string): number => {
      const parsed = JSON.parse(file) as { app?: unknown; kind?: unknown; version?: unknown; settings?: unknown };
      if (parsed.app !== app_info.id) throw new Error("This file was not made by X-Control.");
      if (parsed.kind !== settings_kind || !parsed.settings || typeof parsed.settings !== "object") throw new Error("This file holds no settings.");
      if (typeof parsed.version !== "number" || parsed.version > settings_version) throw new Error("This file was made by a newer X-Control; update this one first.");
      const known = Object.entries(parsed.settings as Settings).filter(([key]) => key in common_setting_defaults && !device_setting_keys.includes(key));
      in_transaction(database, () => known.forEach(([key, value]) => set_setting(database, key, value)));
      return known.length;
    },
  },
  api: {
    get_settings: {
      description:
        "The settings stored, by key; a key missing here has its default. history.keep_days is how long run commands' versions are kept; notify.<kind> turns a kind of notification on or off on this device; plugins holds each plugin's on or off and settings by plugin id; home_assistant.* is this device's link to Home Assistant over MQTT, its password hidden.",
      params: [],
    },
    set_setting: {
      description: "Sets one setting by key to any JSON value.",
      params: [{ name: "key", schema: text("The setting's key, such as history.keep_days.") }, { name: "value", schema: { description: "The new value." } }],
    },
    export_settings: { description: "Every setting shared between devices as one JSON file's text, leaving out those of this device alone.", params: [] },
    import_settings: { description: "Sets the settings a JSON file made by export_settings holds, ignoring keys this version does not know; answers how many were set.", params: [{ name: "file", schema: json_file }] },
  },
});
