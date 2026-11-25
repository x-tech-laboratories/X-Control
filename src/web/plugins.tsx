// The page's side of the plugins: each bundled plugin's panel on a device's page, such as its battery or its
// notifications, and a row in Settings for each plugin with its on or off and its settings. On or off and the settings
// are the same records the daemon's side reads, so a plugin turned off here stops there too.

// ── Imports ──────────────────────────────────────────────────────────────────

import * as React from "react";
import { useEffect, useState, type ComponentType } from "react";
import * as jsx_runtime from "react/jsx-runtime";
import { create_plugin_host, define_plugin, type Plugin, type PluginHost, type PluginManifest, type PluginRecords } from "@x-tech-laboratories/x-libs/plugins";
import { load_plugin_modules, share_modules } from "@x-tech-laboratories/x-libs/web/plugin_imports";
import { SettingsDialogRow } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { PluginSettings, use_plugins } from "@x-tech-laboratories/x-libs/web/react/plugins";
import { Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";

import type { DeviceView } from "../shared/devices/model.ts";
import { app_info, bundled_manifests, plugins_setting } from "../shared/plugins/manifests.ts";
import { calls, page } from "./api.ts";
import { panels } from "./devices/panels.tsx";

// ── Api ──────────────────────────────────────────────────────────────────────

export interface DevicePanelProps {
  device: DeviceView;
  // Runs one of the device's actions by its name within the plugin, such as "ring".
  run: (action: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface PagePluginApi {
  slots: {
    // What a device's page shows for the plugin, such as its battery.
    device_panel: ComponentType<DevicePanelProps>;
  };
}

// Each bundled plugin's page side fills its panel, if it has one.
const bundled_pages = bundled_manifests.map((manifest) =>
  define_plugin<PagePluginApi>({
    ...manifest,
    start: (context) => {
      const panel = panels[manifest.id];
      if (panel) context.fill_slot("device_panel", panel);
    },
  }),
);

// ── Folder ───────────────────────────────────────────────────────────────────

// The web sides of the server's plugins folder; the desktop and phone apps load only the bundled ones.
async function folder_pages(): Promise<Plugin<PagePluginApi>[]> {
  if (page().host !== "web") return [];
  share_modules({ react: React, "react/jsx-runtime": jsx_runtime });
  try {
    const loaded = await load_plugin_modules<PagePluginApi>("api/plugins/index.json");
    for (const problem of loaded.problems) console.warn(`plugin ${problem.name}: ${problem.problem}`);
    return loaded.plugins;
  } catch (error) {
    console.warn("plugins folder:", error);
    return [];
  }
}

// ── Host ─────────────────────────────────────────────────────────────────────

let started: Promise<PluginHost<PagePluginApi>> | null = null;

// Started once, after sign-in, since its records come from the daemon.
export function start_page_plugins(): Promise<PluginHost<PagePluginApi>> {
  started ??= (async () => {
    const host = create_plugin_host<PagePluginApi>({
      app: app_info,
      storage: {
        read: async () => (await calls().get_settings())[plugins_setting] as PluginRecords | undefined,
        write: (records) => calls().set_setting(plugins_setting, records),
      },
      on_error: (plugin_id, error) => console.warn(`plugin ${plugin_id}:`, error),
    });
    for (const plugin of bundled_pages) await host.add(plugin);
    for (const plugin of await folder_pages()) await host.add(plugin);
    await host.start();
    return host;
  })();
  return started;
}

// The started host, or null while it starts.
export function use_page_plugins(): PluginHost<PagePluginApi> | null {
  const [host, set_host] = useState<PluginHost<PagePluginApi> | null>(null);
  useEffect(() => void start_page_plugins().then(set_host), []);
  return host;
}

// For tests, which each start from nothing.
export function forget_page_plugins(): void {
  started = null;
}

// ── Settings ─────────────────────────────────────────────────────────────────

function Rows({ host }: { host: PluginHost<PagePluginApi> }) {
  const statuses = use_plugins(host);
  return (
    <>
      {statuses.map(({ manifest, state, problem }: { manifest: PluginManifest; state: string; problem?: string }) => (
        <SettingsDialogRow key={manifest.id} name={manifest.name} status={state === "running" ? "On" : state === "off" ? "Off" : (problem ?? "Not running")} about={manifest.description}>
          <PluginSettings host={host} plugin_id={manifest.id} heading={null} />
        </SettingsDialogRow>
      ))}
    </>
  );
}

// A row for every plugin, bundled or from the plugins folder, each opening its own dialog.
export function PluginRows() {
  const host = use_page_plugins();
  return host ? <Rows host={host} /> : <Skeleton lines={3} />;
}
