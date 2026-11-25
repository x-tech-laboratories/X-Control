// The sidebar: Devices folding open onto each paired device, This computer, Commands and History, and the sync button
// at the foot.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ShellSection } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SyncButton } from "@x-tech-laboratories/x-libs/web/react/sync_settings";

import type { DeviceView } from "../shared/devices/model.ts";
import { data_watch, page } from "./api.ts";

// ── Sections ─────────────────────────────────────────────────────────────────

// Where the folded sections are kept.
export const sidebar_pref = "x-control-sidebar-collapsed";

// Devices with a row for each paired device and each asking to pair, then This computer, Commands and History.
export function sidebar_sections(devices: DeviceView[]): ShellSection[] {
  const listed = devices.filter((device) => device.pair_state === "paired" || device.pair_state === "incoming");
  return [
    {
      id: "devices",
      label: "Devices",
      href: "#/devices",
      children: listed.length ? listed.map((device) => ({ id: device.id, label: device.name, href: `#/devices/${device.id}` })) : undefined,
    },
    { id: "computer", label: "This computer", href: "#/computer" },
    { id: "commands", label: "Commands", href: "#/commands" },
    { id: "history", label: "History", href: "#/history" },
  ];
}

// Sync on a device that syncs, above the Shell's own theme, account and Settings rows.
export function SidebarFoot() {
  const { device } = page();
  return device ? <SyncButton device={device} subscribe={data_watch.subscribe} on_open_settings={() => (window.location.hash = "/settings")} /> : null;
}
