// The desktop app's page: the preload has put the main process's calls on the window.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import type { CertificateClient } from "@x-tech-laboratories/x-libs/certificate_protocol";
import type { PeerListeningClient } from "@x-tech-laboratories/x-libs/sync_protocol";
import type { EventsClient } from "@x-tech-laboratories/x-libs/electron/events";
import type { LocalMcpClient } from "@x-tech-laboratories/x-libs/local_mcp_protocol";

import { certificates_api_name, desktop_api_name, listening_api_name, device_api_name, events_api_name, control_api_name, local_mcp_api_name, type SyncAndBackupMethods, type ControlEvents, type ControlMethods, type PageApi } from "../../shared/page_api.ts";
import type { DesktopMethods } from "../../shared/desktop.ts";

// ── Api ──────────────────────────────────────────────────────────────────────

type DesktopWindow = Record<string, unknown>;

export function is_desktop(): boolean {
  return control_api_name in window;
}

export function desktop_api(): PageApi {
  const desktop = window as unknown as DesktopWindow;
  const events = desktop[events_api_name] as EventsClient<ControlEvents>;
  const device = desktop[device_api_name] as Client<SyncAndBackupMethods>;
  // The tray opens the page on a route, such as a device.
  events.on("open", (route) => (location.hash = route));
  return {
    host: "desktop",
    calls: desktop[control_api_name] as Client<ControlMethods>,
    device,
    backups: device,
    certificates: desktop[certificates_api_name] as CertificateClient,
    listening: desktop[listening_api_name] as PeerListeningClient,
    local_mcp: desktop[local_mcp_api_name] as LocalMcpClient,
    desktop: desktop[desktop_api_name] as Client<DesktopMethods>,
    on_change: (listener) => events.on("changed", listener),
  };
}
