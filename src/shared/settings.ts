// Settings kept as JSON values by key in the X-Libs settings store, so each feature and plugin can add its own; those
// of one device, such as which notifications it shows, never sync. All of them export and import as one JSON file.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_settings_store, settings_of, type SettingSpec } from "@x-tech-laboratories/x-libs/settings";

import { define_feature } from "./feature.ts";
import { notice_setting_defaults } from "./notices.ts";
import { plugins_setting } from "./plugins/manifests.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export type { Settings } from "@x-tech-laboratories/x-libs/settings";

// The link to Home Assistant over MQTT, which each computer makes for itself.
export const home_assistant_setting_defaults: Record<string, unknown> = {
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

// This computer's System Bridge server, which each computer runs for itself.
export const system_bridge_setting_defaults: Record<string, unknown> = {
  "system_bridge.enabled": false,
  "system_bridge.port": 9170,
};

const common_settings: Record<string, SettingSpec> = {
  ...settings_of({
    // How long History keeps versions of a run command, in days.
    "history.keep_days": 180,
    [plugins_setting]: {},
  }),
  ...settings_of(notice_setting_defaults, { local: true }),
  ...settings_of(home_assistant_setting_defaults, { local: true }),
  "home_assistant.password": { default: "", local: true, secret: true },
  ...settings_of(system_bridge_setting_defaults, { local: true }),
};

// ── Store ────────────────────────────────────────────────────────────────────

export const settings_store = create_settings_store([common_settings], {
  app: { id: "x-control", name: "X-Control" },
  descriptions: {
    get_settings:
      "The settings by key, the ones never set at their defaults. history.keep_days is how long run commands' versions are kept; notify.<kind> turns a kind of notification on or off on this device; plugins holds each plugin's on or off and settings by plugin id; home_assistant.* is this device's link to Home Assistant over MQTT, its password hidden; system_bridge.enabled and system_bridge.port run a System Bridge server on this device.",
  },
  key_example: "history.keep_days",
});

export const settings_feature = define_feature({
  id: settings_store.id,
  migrations: settings_store.migrations,
  tables: settings_store.tables,
  methods: { ...settings_store.methods },
  api: settings_store.api,
});
