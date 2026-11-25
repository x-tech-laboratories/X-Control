// What the page knows of its host without loading the store: the names the calls travel under, and the api's shape.
// The browser build imports only types from the stores, so they stay out of the page a server serves.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { backup_method_names, type BackupClient, type BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import type { CertificateClient } from "@x-tech-laboratories/x-libs/certificate_protocol";
import type { ConnectionClient } from "@x-tech-laboratories/x-libs/connection_protocol";
import type { LocalMcpClient } from "@x-tech-laboratories/x-libs/local_mcp_protocol";
import { sync_device_method_names, type SyncDeviceMethods, type SyncStatus } from "@x-tech-laboratories/x-libs/sync_protocol";

import type { DesktopMethods } from "./desktop.ts";
import type { DeviceMethods } from "./devices/api.ts";
import type { StoreMethods } from "./store.ts";

// ── Names ────────────────────────────────────────────────────────────────────

export const control_api_name = "x_control";
export const device_api_name = "x_control_device";
export const events_api_name = "x_control_events";
export const certificates_api_name = "x_control_certificates";
export const local_mcp_api_name = "x_control_local_mcp";
export const desktop_api_name = "x_control_desktop";

// ── Calls ────────────────────────────────────────────────────────────────────

// Every call the page makes on its daemon: the stored data, and the devices it reaches.
export type ControlMethods = StoreMethods & DeviceMethods;

// Sync with a server and backups of the device's own database; a browser is already on the server.
export type SyncAndBackupMethods = SyncDeviceMethods & BackupMethods;

export const sync_and_backup_method_names = [...sync_device_method_names, ...backup_method_names] as const;

// What the main process tells the page on its own: the data changed elsewhere, sync's status moved, or the tray asked
// for a route such as "#/devices".
export type ControlEvents = { changed: null; sync_status: SyncStatus; open: string };

// A call that only reads; any other call announces a change.
export function is_read_only(method: string): boolean {
  return /^(list|get|search|lookup|export)_/.test(method);
}

// ── The page's api ───────────────────────────────────────────────────────────

export type Host = "web" | "desktop" | "android";

export interface PageApi {
  host: Host;
  calls: Client<ControlMethods>;
  // Null in a browser, which syncs nothing itself.
  device: Client<SyncAndBackupMethods> | null;
  // The backups of the daemon's database; left out where none are offered.
  backups?: BackupClient;
  certificates?: CertificateClient;
  local_mcp?: LocalMcpClient;
  desktop?: Client<DesktopMethods>;
  // The daemons a phone can reach, chosen under Settings → Connections; set only where the page picks its daemon.
  connections?: ConnectionClient;
  // Runs whenever the data or a device changed somewhere else; returns the function that stops listening.
  on_change: (listener: () => void) => () => void;
}
