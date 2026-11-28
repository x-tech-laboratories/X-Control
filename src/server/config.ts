// The server's JSON config: where its data lives, how this device appears to others, which computer services its
// plugins use, and where its notifications go. Every field but the database has a default.

// ── Imports ──────────────────────────────────────────────────────────────────

import { dirname, join, resolve } from "node:path";

import type { DeviceType } from "../shared/kdeconnect/packet.ts";
import type { ControlOptions, NetworkOptions } from "./control.ts";

// ── Config ───────────────────────────────────────────────────────────────────

export interface ServerConfig {
  database: string;
  backups_folder: string;
  // Where paired devices reach this server's sync, such as "https://control.example.org/api/"; null when they cannot.
  sync_address: string | null;
  identity_file: string;
  downloads_folder: string;
  mounts_folder: string;
  plugins_folder: string;
  device_name: string | null;
  device_type: DeviceType;
  // "linux" drives the real desktop; "sample" keeps a computer in memory, for trying the app out.
  system: "linux" | "sample";
  network: NetworkOptions;
  // ntfy, webhook, mail or Apprise entries, as X-Libs' read_channels takes them.
  notify_channels: unknown[];
  // The link to Home Assistant over MQTT, for fields Settings leaves empty.
  home_assistant: NonNullable<ControlOptions["home_assistant"]>;
  // The System Bridge server, where Settings leaves it unset.
  system_bridge: NonNullable<ControlOptions["system_bridge"]>;
}

interface RawConfig {
  database?: unknown;
  backups_folder?: unknown;
  sync_address?: unknown;
  identity_file?: unknown;
  downloads_folder?: unknown;
  mounts_folder?: unknown;
  plugins_folder?: unknown;
  device_name?: unknown;
  device_type?: unknown;
  system?: unknown;
  kdeconnect?: { discovery?: unknown; listen_port?: unknown; announce_port?: unknown; tcp_ports?: unknown; payload_ports?: unknown; allow_loopback?: unknown; mdns?: unknown; bluetooth?: unknown };
  notify_channels?: unknown;
  system_bridge?: { enabled?: unknown; port?: unknown };
  home_assistant?: { enabled?: unknown; broker?: unknown; username?: unknown; password_file?: unknown; password_credential?: unknown; discovery_prefix?: unknown; base_topic?: unknown; interval?: unknown };
}

function port_range(value: unknown): { lowest: number; highest: number } | undefined {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((port) => Number.isInteger(port))) return undefined;
  return { lowest: value[0] as number, highest: value[1] as number };
}

function optional_port(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

// The password comes from a file, or from a systemd credential by name, as the NixOS module hands it over.
function read_home_assistant(raw: NonNullable<RawConfig["home_assistant"]>, credentials = process.env.CREDENTIALS_DIRECTORY): ServerConfig["home_assistant"] {
  const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
  const found: ServerConfig["home_assistant"] = {};
  if (typeof raw.enabled === "boolean") found.enabled = raw.enabled;
  if (text(raw.broker)) found.broker = text(raw.broker);
  if (text(raw.username)) found.username = text(raw.username);
  if (text(raw.password_file)) found.password_file = resolve(text(raw.password_file)!);
  else if (text(raw.password_credential) && credentials) found.password_file = join(credentials, text(raw.password_credential)!);
  if (text(raw.discovery_prefix)) found.discovery_prefix = text(raw.discovery_prefix);
  if (text(raw.base_topic)) found.base_topic = text(raw.base_topic);
  if (typeof raw.interval === "number" && raw.interval >= 1) found.interval = raw.interval;
  return found;
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
    sync_address: typeof raw.sync_address === "string" && raw.sync_address ? raw.sync_address : null,
    identity_file: path_or(raw.identity_file, join(data_folder, "identity.json")),
    downloads_folder: path_or(raw.downloads_folder, join(data_folder, "received")),
    mounts_folder: path_or(raw.mounts_folder, join(data_folder, "mounts")),
    plugins_folder: path_or(raw.plugins_folder, join(data_folder, "plugins")),
    device_name: typeof raw.device_name === "string" && raw.device_name ? raw.device_name : null,
    device_type: raw.device_type === "laptop" || raw.device_type === "phone" || raw.device_type === "tablet" || raw.device_type === "tv" ? raw.device_type : "desktop",
    system: raw.system === "sample" ? "sample" : "linux",
    network: {
      discovery: network.discovery !== false,
      mdns: network.mdns !== false,
      bluetooth: typeof network.bluetooth === "boolean" ? network.bluetooth : undefined,
      listen_port: optional_port(network.listen_port),
      announce_port: optional_port(network.announce_port),
      tcp_ports: port_range(network.tcp_ports),
      payload_ports: port_range(network.payload_ports),
      // Only a dev or test run talks to devices on the same computer.
      allow_loopback: network.allow_loopback === true,
    },
    notify_channels: Array.isArray(raw.notify_channels) ? raw.notify_channels : [],
    home_assistant: read_home_assistant(raw.home_assistant ?? {}),
    system_bridge: {
      ...(typeof raw.system_bridge?.enabled === "boolean" ? { enabled: raw.system_bridge.enabled } : {}),
      ...(optional_port(raw.system_bridge?.port) ? { port: optional_port(raw.system_bridge?.port) } : {}),
    },
  };
}
