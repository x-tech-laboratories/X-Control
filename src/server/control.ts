// X-Control's working core, the same in the server and the desktop daemon: this device's KDE Connect identity, the
// plugin host with every bundled plugin, the paired and connected devices, the network they are reached over, this
// computer's readings and controls, the link that publishes them to Home Assistant, and its System Bridge server.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { create_plugin_host, type PluginHost, type PluginRecords, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { ComputerMethods } from "../shared/computer/api.ts";
import type { DeviceMethods } from "../shared/devices/api.ts";
import type { SystemBridgeMethods } from "../shared/system_bridge/api.ts";
import { clean_device_name } from "../shared/kdeconnect/packet.ts";
import { notice_setting, type Notice } from "../shared/notices.ts";
import { app_info, plugins_setting } from "../shared/plugins/manifests.ts";
import { commands_feature } from "../shared/commands/store.ts";
import { paired_store } from "../shared/devices/store.ts";
import { home_assistant_setting_defaults, settings_feature } from "../shared/settings.ts";
import { create_readings, type Readings } from "./computer/readings.ts";
import { create_home_assistant_bridge, default_home_assistant_settings, type HomeAssistantBridge, type HomeAssistantSettings, type SessionFactory } from "./home_assistant/bridge.ts";
import { create_device_manager, type DeviceManager } from "./kdeconnect/devices.ts";
import { fingerprint_of, load_identity, save_identity, type DeviceIdentity } from "./kdeconnect/identity.ts";
import { create_lan_backend, type LanBackend, type LanOptions } from "./kdeconnect/lan.ts";
import { start_mdns, type MdnsDiscovery } from "./kdeconnect/mdns.ts";
import { create_bluetooth_backend, type BluetoothBackend } from "./kdeconnect/bluetooth/backend.ts";
import { system_bluez, unix_fd_support, type BluezBus } from "./kdeconnect/bluetooth/bluez.ts";
import type { ControlPlugin, ControlPluginApi } from "./plugins/api.ts";
import { bundled_plugins } from "./plugins/bundled.ts";
import type { SystemServices } from "./system/services.ts";
import { as_uuid } from "./system_bridge/modules.ts";
import { create_system_bridge_link, system_bridge_settings, type SystemBridgeLink, type SystemBridgeSettings } from "./system_bridge/link.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export type NetworkOptions = Pick<LanOptions, "discovery" | "listen_port" | "announce_port" | "tcp_ports" | "payload_ports" | "allow_loopback" | "broadcast_addresses"> & {
  // Advertise and find devices over mDNS as well as by broadcast; on wherever discovery is.
  mdns?: boolean;
  // Reach bonded devices over Bluetooth through BlueZ; when left out, on wherever discovery is.
  bluetooth?: boolean;
};

export interface ControlOptions {
  database: () => SqlDatabase;
  // The file this device's identity and certificate are kept in.
  identity_file: string;
  downloads_folder: string;
  // Where phones' files are mounted while they are browsed.
  mounts_folder: string;
  system: SystemServices;
  // Shows a notice the user turned on, on the desktop or through the server's channels.
  notify: (notice: Notice) => void;
  withdraw: (key: string) => void;
  // A device or plugin changed; the pages fetch again.
  on_change: () => void;
  network?: NetworkOptions;
  // The name and type a new identity starts with.
  defaults?: { name?: string; type?: DeviceIdentity["type"] };
  // Plugins from the plugins folder, which join after the bundled ones.
  folder_plugins?: ControlPlugin[];
  // The link to Home Assistant from the config file, used where Settings leaves a field empty; the password is read from its file.
  home_assistant?: Partial<Omit<HomeAssistantSettings, "password">> & { password_file?: string };
  // The System Bridge server from the config file, used where Settings leaves it unset.
  system_bridge?: Partial<SystemBridgeSettings>;
  // How Bluetooth reaches BlueZ; tests hand in a BlueZ of their own.
  bluez?: () => Promise<BluezBus>;
  // How the bridge reaches the broker; tests hand in their own.
  mqtt_session?: SessionFactory;
  log?: (message: string) => void;
}

export interface Control {
  methods: DeviceMethods & ComputerMethods & SystemBridgeMethods;
  plugins: PluginHost<ControlPluginApi>;
  devices: DeviceManager;
  network: LanBackend;
  readings: Readings;
  home_assistant: HomeAssistantBridge;
  system_bridge: SystemBridgeLink;
  identity(): DeviceIdentity;
  // Brings the plugins in line with their records after Settings changed them, and tells devices of new commands.
  after_store_change(method: string): Promise<void>;
  stop(): Promise<void>;
}

// ── Plugins ──────────────────────────────────────────────────────────────────

function plugin_records(database: SqlDatabase): PluginRecords {
  const saved = settings_feature.methods.get_settings(database)[plugins_setting];
  return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as PluginRecords) : {};
}

function same_values(first: SettingValues, second: SettingValues): boolean {
  return JSON.stringify(Object.entries(first).sort()) === JSON.stringify(Object.entries(second).sort());
}

// The link to Home Assistant as Settings has it, each field left empty taken from the config file.
export function home_assistant_settings(stored: Record<string, unknown>, from_config: ControlOptions["home_assistant"] = {}): HomeAssistantSettings {
  // Settings holds only the values the user set.
  const value = (key: keyof HomeAssistantSettings): unknown => {
    const set = stored[`home_assistant.${key}`];
    return set !== undefined && set !== "" ? set : ((from_config as Record<string, unknown>)[key] ?? home_assistant_setting_defaults[`home_assistant.${key}`]);
  };
  const text = (key: keyof HomeAssistantSettings): string => (typeof value(key) === "string" ? (value(key) as string) : "");
  let password = typeof stored["home_assistant.password"] === "string" ? (stored["home_assistant.password"] as string) : "";
  if (!password && from_config.password_file) {
    try {
      password = readFileSync(from_config.password_file, "utf8").trim();
    } catch {
      password = "";
    }
  }
  return {
    enabled: value("enabled") === true,
    broker: text("broker"),
    username: text("username"),
    password,
    discovery_prefix: text("discovery_prefix") || default_home_assistant_settings.discovery_prefix,
    base_topic: text("base_topic") || default_home_assistant_settings.base_topic,
    interval: Math.max(1, Number(value("interval")) || default_home_assistant_settings.interval),
  };
}

// ── Control ──────────────────────────────────────────────────────────────────

export async function start_control(options: ControlOptions): Promise<Control> {
  const log = options.log ?? ((message: string) => console.info(message));
  let identity = await load_identity(options.identity_file, options.defaults);

  // A kind of notice turned off in Settings is never shown on this device.
  const notify = (notice: Notice): void => {
    const setting = settings_feature.methods.get_settings(options.database())[notice_setting(notice.kind)];
    if (setting !== false) options.notify(notice);
  };

  const plugins = create_plugin_host<ControlPluginApi>({
    app: app_info,
    storage: {
      read: () => plugin_records(options.database()),
      write: (records) => settings_feature.methods.set_setting(options.database(), plugins_setting, records),
    },
    services: {
      system: options.system,
      notify,
      withdraw: options.withdraw,
      downloads_folder: () => options.downloads_folder,
      mounts_folder: () => options.mounts_folder,
      devices: () => devices.list(),
      commands: () => commands_feature.methods.list_commands(options.database()),
      log,
    },
    on_error: (plugin_id, error) => log(`plugin ${plugin_id}: ${error instanceof Error ? error.message : String(error)}`),
  });

  const devices = create_device_manager({
    identity: () => identity,
    paired: paired_store(options.database),
    capabilities: () => plugins.providers("capability").map((provided) => ({ plugin_id: provided.plugin_id, capability: provided.value })),
    notify,
    withdraw: options.withdraw,
    on_change: options.on_change,
    on_event: (event, device) => void plugins.call(event, device),
    log,
  });

  const network = create_lan_backend({
    ...options.network,
    identity: () => identity,
    capabilities: () => devices.capabilities(),
    trusted_certificate: (id) => devices.trusted_certificate(id),
    is_connected: (id) => devices.is_connected(id),
    // Paired devices away from this network may still be reached where they last were, such as across a VPN.
    known_addresses: () => devices.list().flatMap((device) => (device.pair_state === "paired" && !device.is_connected && device.address ? [device.address] : [])),
    on_link: (link) => devices.attach(link),
    on_warning: log,
  });

  const stored_settings = (): Record<string, unknown> => settings_feature.methods.get_settings(options.database());
  const readings = create_readings({
    sources: () => plugins.providers("entities"),
    interval: () => home_assistant_settings(stored_settings(), options.home_assistant).interval,
    log,
  });
  const home_assistant = create_home_assistant_bridge({
    readings,
    settings: () => home_assistant_settings(stored_settings(), options.home_assistant),
    device: () => ({ id: identity.device_id, name: identity.name, version: app_info.version }),
    connect: options.mqtt_session,
    on_status: options.on_change,
    log,
  });
  const system_bridge = create_system_bridge_link({
    system: options.system,
    commands: () => commands_feature.methods.list_commands(options.database()),
    notify,
    withdraw: options.withdraw,
    // KDE Connect's id written as a UUID, so System Bridge clients know this computer by the same id.
    uuid: () => as_uuid(identity.device_id),
    keys_file: join(dirname(options.identity_file), "system-bridge-keys.json"),
    downloads_folder: options.downloads_folder,
    settings: () => system_bridge_settings(stored_settings(), options.system_bridge),
    mdns: options.network?.discovery !== false && options.network?.mdns !== false,
    on_change: options.on_change,
    log,
  });
  let bridge_settings = JSON.stringify(home_assistant_settings(stored_settings(), options.home_assistant));

  for (const plugin of [...bundled_plugins, ...(options.folder_plugins ?? [])]) await plugins.add(plugin);
  await plugins.start();
  plugins.watch.subscribe(() => {
    readings.forget_list();
    options.on_change();
  });
  await network.start();
  const mdns: MdnsDiscovery | null = options.network?.discovery !== false && options.network?.mdns !== false ? start_mdns({ identity: () => identity, announce: (address) => network.announce(address), on_warning: log }) : null;
  home_assistant.start();
  await system_bridge.follow_settings();
  // Bluetooth needs descriptors passed over D-Bus, which takes the native usocket module.
  const bluetooth: BluetoothBackend | null =
    (options.network?.bluetooth ?? options.network?.discovery !== false)
      ? create_bluetooth_backend({
          bus:
            options.bluez ??
            (async () => {
              const support = unix_fd_support();
              if (!support.ok) throw new Error(support.reason);
              return system_bluez();
            }),
          identity: () => identity,
          capabilities: () => devices.capabilities(),
          trusted_certificate: (id) => devices.trusted_certificate(id),
          is_connected: (id) => devices.is_connected(id),
          on_link: (link) => devices.attach(link),
          log,
        })
      : null;
  await bluetooth?.start();
  log(`X-Control is ${identity.name} (${identity.device_id}) on TCP port ${network.tcp_port()}`);

  // Records changed on another page or device: each plugin is turned on or off and given its settings to match.
  async function follow_plugin_records(): Promise<void> {
    const records = plugin_records(options.database());
    for (const status of plugins.list()) {
      const record = records[status.manifest.id];
      const wanted = record?.enabled ?? status.manifest.enabled_by_default ?? true;
      if (!wanted && status.state !== "off") await plugins.disable(status.manifest.id);
      if (wanted && status.state === "off") await plugins.enable(status.manifest.id);
      if (record?.settings && !same_values(record.settings, plugins.settings(status.manifest.id))) await plugins.set_settings(status.manifest.id, { ...plugins.settings(status.manifest.id), ...record.settings });
    }
  }

  const methods: DeviceMethods & ComputerMethods & SystemBridgeMethods = {
    get_this_device: async () => {
      const status = bluetooth?.status();
      return { id: identity.device_id, name: identity.name, type: identity.type, tcp_port: network.tcp_port(), fingerprint: fingerprint_of(identity.certificate), discovery: options.network?.discovery !== false, bluetooth: { state: status?.state ?? "off", error: status?.error ?? null } };
    },
    rename_this_device: async (name) => {
      identity = { ...identity, name: clean_device_name(name) };
      save_identity(options.identity_file, identity);
      network.announce();
      // Home Assistant shows the new name on the device.
      readings.forget_list();
      options.on_change();
    },
    list_devices: async () => devices.list(),
    get_device: async (id) => devices.get(id),
    list_device_actions: async (id) => devices.actions(id),
    run_device_action: async (id, action, args) => devices.run_action(id, action, args ?? {}),
    pair_device: (id) => devices.request_pair(id),
    accept_pairing: (id) => devices.accept_pair(id),
    reject_pairing: (id) => devices.reject_pair(id),
    unpair_device: (id) => devices.unpair(id),
    refresh_devices: async () => {
      network.announce();
      await bluetooth?.connect_now();
    },
    connect_address: async (address) => network.announce(address.trim()),
    list_readings: () => readings.refresh(),
    set_control: (id, value) => readings.set(id, value),
    get_home_assistant_status: async () => home_assistant.status(),
    ...system_bridge.methods,
  };

  return {
    methods,
    plugins,
    devices,
    network,
    readings,
    home_assistant,
    system_bridge,
    identity: () => identity,
    async after_store_change(method) {
      if (method === "set_setting" || method === "import_settings") {
        await follow_plugin_records();
        const now = JSON.stringify(home_assistant_settings(stored_settings(), options.home_assistant));
        if (now !== bridge_settings) {
          bridge_settings = now;
          home_assistant.restart();
        }
        await system_bridge.follow_settings();
      }
      if (/_command|commands/.test(method) || method === "restore_version") {
        readings.forget_list();
        await plugins.call("commands.changed");
      }
    },
    async stop() {
      await home_assistant.stop();
      await system_bridge.stop();
      await bluetooth?.stop();
      devices.stop();
      await mdns?.stop();
      await network.stop();
      await plugins.stop();
    },
  };
}

// The folder files from devices land in: the user's downloads, or one beside the data on a server.
export function default_downloads_folder(home: string | undefined, data_folder: string): string {
  return home ? join(home, "Downloads") : join(data_folder, "received");
}
