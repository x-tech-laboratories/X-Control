// The bridges the desktop app's main process and preload use, and the call table the server and daemon answer.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";
import { define_bridge } from "@x-tech-laboratories/x-libs/electron/bridge";
import { certificate_method_names, type CertificateMethods } from "@x-tech-laboratories/x-libs/certificate_protocol";
import { local_mcp_method_names, type LocalMcpMethods } from "@x-tech-laboratories/x-libs/local_mcp_protocol";
import { define_events } from "@x-tech-laboratories/x-libs/electron/events";

import { computer_api, computer_method_names } from "./computer/api.ts";
import { desktop_method_names, type DesktopMethods } from "./desktop.ts";
import { device_api, device_method_names } from "./devices/api.ts";
import {
  certificates_api_name,
  control_api_name,
  desktop_api_name,
  device_api_name,
  events_api_name,
  local_mcp_api_name,
  sync_and_backup_method_names,
  type ControlEvents,
  type ControlMethods,
  type SyncAndBackupMethods,
} from "./page_api.ts";
import { store_api, store_method_names } from "./store.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export const control_method_names = [...store_method_names, ...device_method_names, ...computer_method_names] as (keyof ControlMethods & string)[];

// What every call does and takes, for programs other than the page.
export const control_api = { ...store_api, ...device_api, ...computer_api } as ApiSpec<ControlMethods>;

// ── Bridges ──────────────────────────────────────────────────────────────────

export const control_bridge = define_bridge<ControlMethods>(control_api_name, control_method_names);

export const device_bridge = define_bridge<SyncAndBackupMethods>(device_api_name, sync_and_backup_method_names);

// Server certificates the user chose to trust, such as a home sync server's self-signed one.
export const certificate_bridge = define_bridge<CertificateMethods>(certificates_api_name, certificate_method_names);

// The desktop app's own MCP endpoint, for AI clients on the same computer.
export const local_mcp_bridge = define_bridge<LocalMcpMethods>(local_mcp_api_name, local_mcp_method_names);

// The desktop app's own settings and quitting, answered by the main process.
export const desktop_bridge = define_bridge<DesktopMethods>(desktop_api_name, desktop_method_names);

export const control_events = define_events<ControlEvents>(events_api_name);
