// This computer's System Bridge server as the control core runs it: on or off and its port from Settings, started
// again when they change, its keys kept beside this device's identity, and the calls the page makes on it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { homedir } from "node:os";

import type { Notice } from "../../shared/notices.ts";
import type { SystemBridgeMethods, SystemBridgeStatus } from "../../shared/system_bridge/api.ts";
import type { RunCommand } from "../plugins/api.ts";
import type { SystemServices } from "../system/services.ts";
import { media_folders } from "./files.ts";
import { create_key_store } from "./keys.ts";
import { create_modules } from "./modules.ts";
import { create_system_bridge_server, default_bridge_port, type BridgeServer } from "./server.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface SystemBridgeSettings {
  enabled: boolean;
  port: number;
}

export interface SystemBridgeLinkOptions {
  system: SystemServices;
  commands: () => RunCommand[];
  notify: (notice: Notice) => void;
  withdraw: (key: string) => void;
  uuid: () => string;
  keys_file: string;
  downloads_folder: string;
  settings: () => SystemBridgeSettings;
  mdns: boolean;
  // A change other pages should hear of, such as the server starting.
  on_change?: () => void;
  log?: (message: string) => void;
}

export interface SystemBridgeLink {
  methods: SystemBridgeMethods;
  // Starts, stops or moves the server to match Settings.
  follow_settings(): Promise<void>;
  stop(): Promise<void>;
}

// The settings as stored, each missing one at its default.
export function system_bridge_settings(stored: Record<string, unknown>, from_config: Partial<SystemBridgeSettings> = {}): SystemBridgeSettings {
  const enabled = stored["system_bridge.enabled"] ?? from_config.enabled ?? false;
  const port = Number(stored["system_bridge.port"] ?? from_config.port ?? default_bridge_port);
  return { enabled: enabled === true, port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : default_bridge_port };
}

// ── Link ─────────────────────────────────────────────────────────────────────

export function create_system_bridge_link(options: SystemBridgeLinkOptions): SystemBridgeLink {
  const keys = create_key_store(options.keys_file);
  const modules = create_modules({ system: options.system, uuid: options.uuid, log: options.log });
  let server: BridgeServer | null = null;
  let running: SystemBridgeSettings | null = null;
  let status: Omit<SystemBridgeStatus, "clients" | "uuid"> = { state: "off", port: null, error: null };
  let queue: Promise<void> = Promise.resolve();

  async function apply(): Promise<void> {
    const wanted = options.settings();
    if (running && wanted.enabled && running.port === wanted.port) return;
    if (server) await server.stop();
    server = null;
    running = null;
    status = { state: "off", port: null, error: null };
    if (wanted.enabled) {
      const next = create_system_bridge_server({
        port: wanted.port,
        keys,
        modules,
        system: options.system,
        commands: options.commands,
        notify: options.notify,
        withdraw: options.withdraw,
        // A service user's home of "/" would offer the whole disk, so only a real home folder is offered.
        folders: () => media_folders(homedir() && homedir() !== "/" ? homedir() : undefined, options.downloads_folder),
        uuid: options.uuid,
        mdns: options.mdns,
        log: options.log,
      });
      try {
        status = { state: "listening", port: await next.start(), error: null };
        server = next;
        running = wanted;
      } catch (error) {
        await next.stop().catch(() => {});
        status = { state: "failed", port: wanted.port, error: error instanceof Error ? error.message : String(error) };
        options.log?.(`System Bridge: ${status.error}`);
      }
    }
    options.on_change?.();
  }

  return {
    methods: {
      get_system_bridge_status: async () => ({ ...status, clients: server?.clients() ?? 0, uuid: options.uuid() }),
      list_system_bridge_keys: async () => keys.list(),
      create_system_bridge_key: async (name) => keys.create(name),
      remove_system_bridge_key: async (id) => keys.remove(id),
      create_system_bridge_pairing_code: async () => keys.pairing_code(),
    },
    // One change at a time, so a quick on and off never leaves two servers.
    follow_settings() {
      queue = queue.then(apply, apply);
      return queue;
    },
    async stop() {
      await queue.catch(() => {});
      await server?.stop();
      server = null;
      running = null;
    },
  };
}
