// What the tray shows, worked out apart from Electron: each paired device with its battery, opening its page, and
// the window and quit commands.

// ── Imports ──────────────────────────────────────────────────────────────────

import { app_rows, tray_groups, type TrayRow, type TrayView } from "@x-tech-laboratories/x-libs/electron/tray";

import type { DeviceView } from "../shared/devices/model.ts";
import type { BatteryState } from "../shared/plugins/states.ts";

// ── Menu ─────────────────────────────────────────────────────────────────────

export interface TrayActions {
  open_route: (route: string) => void;
  show: () => void;
  quit: () => void;
  quit_completely: () => void;
}

// A device as one line: its name, then its battery or that it is away.
export function device_label(device: DeviceView): string {
  if (!device.is_connected) return `${device.name} — not connected`;
  const battery = device.plugins.battery as BatteryState | undefined;
  return battery && battery.charge >= 0 ? `${device.name} — ${battery.charge}%${battery.is_charging ? " charging" : ""}` : device.name;
}

// Requests to pair first, then each paired device, then showing the window and quitting.
export function tray_view(devices: DeviceView[], actions: TrayActions): TrayView {
  const asking = devices
    .filter((device) => device.pair_state === "incoming")
    .map((device): TrayRow => ({ kind: "item", label: `${device.name} asks to pair`, run: () => actions.open_route(`#/devices/${device.id}`) }));
  const paired = devices
    .filter((device) => device.pair_state === "paired")
    .map((device): TrayRow => ({ kind: "item", label: device_label(device), run: () => actions.open_route(`#/devices/${device.id}`) }));
  const connected = devices.filter((device) => device.pair_state === "paired" && device.is_connected).length;
  return {
    tooltip: `X-Control — ${connected} ${connected === 1 ? "device" : "devices"} connected`,
    rows: tray_groups(asking, paired, app_rows({ app_name: "X-Control", show: actions.show, quit: actions.quit, quit_completely: actions.quit_completely })),
  };
}
