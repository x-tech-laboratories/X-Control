// The server's JSON config: where its data lives, how this device appears to others, which computer services its
// plugins use, and where its notifications go. Every field but the database has a default.

// ── Imports ──────────────────────────────────────────────────────────────────

import { dirname, join, resolve } from "node:path";

import type { DeviceType } from "../shared/kdeconnect/packet.ts";
import type { NetworkOptions } from "./control.ts";

// ── Config ───────────────────────────────────────────────────────────────────

export interface ServerConfig {
  database: string;
  backups_folder: string;
  identity_file: string;
  downloads_folder: string;
  plugins_folder: string;
  device_name: string | null;
  device_type: DeviceType;
  // "linux" drives the real desktop; "sample" keeps a computer in memory, for trying the app out.
  system: "linux" | "sample";
  network: NetworkOptions;
  // ntfy, webhook, mail or Apprise entries, as X-Libs' read_channels takes them.
  notify_channels: unknown[];
}

interface RawConfig {
  database?: unknown;
  backups_folder?: unknown;
  identity_file?: unknown;
  downloads_folder?: unknown;
  plugins_folder?: unknown;
  device_name?: unknown;
  device_type?: unknown;
  system?: unknown;
  kdeconnect?: { discovery?: unknown; listen_port?: unknown; announce_port?: unknown; tcp_ports?: unknown; payload_ports?: unknown; allow_loopback?: unknown };
  notify_channels?: unknown;
}

function port_range(value: unknown): { lowest: number; highest: number } | undefined {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((port) => Number.isInteger(port))) return undefined;
  return { lowest: value[0] as number, highest: value[1] as number };
}

function optional_port(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

// The config as the server uses it, with every path made absolute and each missing field at its default.
export function read_config(raw: RawConfig): ServerConfig {
  if (typeof raw.database !== "string" || !raw.database) throw new Error("the config must name the database");
  const database = resolve(raw.database);
  const data_folder = dirname(database);
  const path_or = (value: unknown, fallback: string): string => (typeof value === "string" && value ? resolve(value) : fallback);
  const network = raw.kdeconnect ?? {};
  return {
    database,
    backups_folder: path_or(raw.backups_folder, join(data_folder, "backups")),
    identity_file: path_or(raw.identity_file, join(data_folder, "identity.json")),
    downloads_folder: path_or(raw.downloads_folder, join(data_folder, "received")),
    plugins_folder: path_or(raw.plugins_folder, join(data_folder, "plugins")),
    device_name: typeof raw.device_name === "string" && raw.device_name ? raw.device_name : null,
    device_type: raw.device_type === "laptop" || raw.device_type === "phone" || raw.device_type === "tablet" || raw.device_type === "tv" ? raw.device_type : "desktop",
    system: raw.system === "sample" ? "sample" : "linux",
    network: {
      discovery: network.discovery !== false,
      listen_port: optional_port(network.listen_port),
      announce_port: optional_port(network.announce_port),
      tcp_ports: port_range(network.tcp_ports),
      payload_ports: port_range(network.payload_ports),
      // Only a dev or test run talks to devices on the same computer.
      allow_loopback: network.allow_loopback === true,
    },
    notify_channels: Array.isArray(raw.notify_channels) ? raw.notify_channels : [],
  };
}
