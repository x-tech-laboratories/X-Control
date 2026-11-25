// System Bridge's data modules, built from this computer's readings in the shapes Home Assistant's system_bridge
// integration parses: every module answers, an empty object or list where there is nothing to say, never null.

// ── Imports ──────────────────────────────────────────────────────────────────

import { networkInterfaces } from "node:os";

import { main_player } from "../plugins/desktop_controls.ts";
import { rate_tracker } from "../plugins/helpers.ts";
import { main_address } from "../plugins/network.ts";
import type { SystemServices } from "../system/services.ts";

// ── Modules ──────────────────────────────────────────────────────────────────

// The modules Home Assistant asks for at setup, and audio, which it asks for after.
export const core_modules = ["battery", "cpu", "disks", "displays", "gpus", "media", "memory", "networks", "processes", "system"] as const;
export const all_modules = [...core_modules, "audio"] as const;

export type ModuleName = (typeof all_modules)[number];

export function is_module(name: unknown): name is ModuleName {
  return typeof name === "string" && (all_modules as readonly string[]).includes(name);
}

const list_modules = new Set<ModuleName>(["displays", "gpus", "processes"]);

// The version told to clients: System Bridge's, which Home Assistant checks is 5.28.6 or newer.
export const bridge_version = "5.31.3";

export interface ModuleOptions {
  system: SystemServices;
  // Stable across restarts; Home Assistant keys every entity by it.
  uuid: () => string;
  log?: (message: string) => void;
}

export interface Modules {
  read(name: ModuleName): Promise<unknown>;
}

const mib = 1024 * 1024;

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function percent_of(part: number, whole: number): number {
  return whole > 0 ? round((part / whole) * 100) : 0;
}

// A UUID written with its dashes, from KDE Connect's 32 hex digits.
export function as_uuid(id: string): string {
  const hex = id.replace(/[^0-9a-f]/gi, "").toLowerCase().padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The processor's own temperature among the sensors, as k10temp, coretemp and zenpower name it.
export function processor_temperature(sensors: { id: string; celsius: number }[]): number | null {
  const found = sensors.find((sensor) => /^(k10temp_tctl|k10temp|coretemp_package|zenpower_tdie|cpu_package|coretemp)/.test(sensor.id)) ?? sensors.find((sensor) => /cpu|k10temp|coretemp/.test(sensor.id));
  return found ? found.celsius : null;
}

// ── Builders ─────────────────────────────────────────────────────────────────

export function create_modules(options: ModuleOptions): Modules {
  const { system } = options;
  const { readings } = system;
  const rate = rate_tracker();
  const rate_or_null = (key: string, value: number): number | null => {
    const found = rate(key, value);
    return found === null ? null : round(found);
  };

  const builders: Record<ModuleName, () => Promise<unknown>> = {
    async system() {
      const [info, uptime, interfaces, in_use, restart, idle, locked, profiles] = await Promise.all([
        readings.system_info(),
        readings.uptime(),
        readings.interfaces(),
        readings.devices_in_use().catch(() => ({ camera: false, microphone: false, speakers: false })),
        readings.restart_needed().catch(() => null),
        readings.idle_seconds().catch(() => null),
        system.session.is_locked().catch(() => null),
        system.power.profiles().catch(() => null),
      ]);
      const address = main_address(interfaces) ?? "";
      const mac = Object.values(networkInterfaces()).flat().find((entry) => entry?.address === address)?.mac ?? "00:00:00:00:00:00";
      const ipv6 = interfaces.find((card) => card.addresses.includes(address))?.addresses.find((entry) => entry.includes(":")) ?? null;
      return {
        boot_time: Math.round(Date.now() / 1000 - uptime),
        fqdn: info.hostname,
        hostname: info.hostname,
        kernel_version: info.kernel_version,
        ip_address_4: address,
        ip_address_6: ipv6,
        mac_address: mac,
        platform: "linux",
        platform_version: info.platform_version,
        uptime,
        users: [],
        uuid: options.uuid(),
        version: bridge_version,
        version_latest: bridge_version,
        version_latest_url: null,
        version_newer_available: false,
        run_mode: "standalone",
        camera_usage: in_use.camera ? ["camera"] : [],
        microphone_usage: in_use.microphone ? ["microphone"] : [],
        pending_reboot: restart,
        package_updates: null,
        package_update_list: null,
        power_usage: null,
        device_info: info.device,
        failed_units: null,
        idle_time: idle,
        locked,
        power_profile: profiles?.active ?? null,
        power_profiles: profiles?.available ?? [],
        keep_awake: system.power.is_kept_awake(),
        keep_awake_until: null,
      };
    },

    async cpu() {
      const [cpu, temperatures] = await Promise.all([readings.cpu(), readings.temperatures().catch(() => [])]);
      return {
        count: cpu.cores,
        name: cpu.model || null,
        vendor: null,
        family: null,
        frequency: null,
        load_average: cpu.load[0],
        load_average_5: cpu.load[1],
        load_average_15: cpu.load[2],
        per_cpu: cpu.cores_busy.map((usage, id) => ({ id, frequency: null, power: null, times: null, times_percent: null, usage, voltage: null })),
        power: null,
        stats: null,
        temperature: processor_temperature(temperatures),
        times: null,
        times_percent: null,
        usage: cpu.busy,
        voltage: null,
      };
    },

    async memory() {
      const memory = await readings.memory();
      const used = memory.total_bytes - memory.available_bytes;
      const swap_used = memory.swap_total_bytes - memory.swap_free_bytes;
      return {
        virtual: { total: memory.total_bytes, available: memory.available_bytes, used, free: memory.available_bytes, percent: percent_of(used, memory.total_bytes) },
        swap: { total: memory.swap_total_bytes, used: swap_used, free: memory.swap_free_bytes, percent: percent_of(swap_used, memory.swap_total_bytes) },
      };
    },

    async disks() {
      const [mounts, counters] = await Promise.all([readings.disks(), readings.disk_counters()]);
      const counters_of = (name: string, read_bytes: number, write_bytes: number) => ({
        read_count: 0,
        write_count: 0,
        read_bytes,
        write_bytes,
        read_time: 0,
        write_time: 0,
        read_bytes_rate: rate_or_null(`${name}.read`, read_bytes),
        write_bytes_rate: rate_or_null(`${name}.write`, write_bytes),
      });
      const partition_of = (mount: (typeof mounts)[number]) => {
        const used = mount.total_bytes - mount.free_bytes;
        return { device: mount.device, mount_point: mount.mount, filesystem_type: mount.file_system, options: "", max_file_size: 0, max_path_length: 0, category: "primary", usage: { total: mount.total_bytes, used, free: mount.free_bytes, percent: percent_of(used, mount.total_bytes) } };
      };
      const placed = new Set<string>();
      const devices: Record<string, unknown>[] = counters.map((disk) => {
        const partitions = mounts.filter((mount) => mount.device.includes(disk.device));
        for (const mount of partitions) placed.add(mount.mount);
        return { name: disk.device, partitions: partitions.map(partition_of), io_counters: counters_of(disk.device, disk.read_bytes, disk.written_bytes), temperature: null };
      });
      // Pools such as ZFS and network shares name no disk; each pool or share is a device of its own.
      const others = new Map<string, (typeof mounts)[number][]>();
      for (const mount of mounts.filter((entry) => !placed.has(entry.mount))) {
        const name = mount.device.startsWith("/dev/") ? mount.device.slice(5) : mount.device.split("/")[0]!;
        others.set(name, [...(others.get(name) ?? []), mount]);
      }
      for (const [name, entries] of others) devices.push({ name, partitions: entries.map(partition_of), temperature: null });
      const total = (key: "read_bytes" | "written_bytes"): number => counters.reduce((sum, disk) => sum + disk[key], 0);
      return { devices, io_counters: counters_of("all", total("read_bytes"), total("written_bytes")) };
    },

    async networks() {
      const [interfaces, wifi] = await Promise.all([readings.interfaces(), readings.wifi().catch(() => null)]);
      const io_of = (name: string, received: number, sent: number) => ({ bytes_recv: received, bytes_sent: sent, bytes_recv_rate: rate_or_null(`${name}.recv`, received), bytes_sent_rate: rate_or_null(`${name}.sent`, sent) });
      return {
        io: io_of("all", interfaces.reduce((sum, card) => sum + card.received_bytes, 0), interfaces.reduce((sum, card) => sum + card.sent_bytes, 0)),
        networks: interfaces.map((card) => ({
          name: card.name,
          addresses: card.addresses.map((address) => ({ address, family: address.includes(":") ? "AF_INET6" : "AF_INET", netmask: null, broadcast: null, ptp: null })),
          stats: { isup: card.is_up, duplex: null, speed: null, mtu: null, flags: card.is_up ? ["up"] : [] },
          io: io_of(card.name, card.received_bytes, card.sent_bytes),
          wifi: wifi && wifi.interface === card.name ? { ssid: wifi.network, signal: wifi.signal_dbm, signal_percent: null, link_rate: null } : null,
        })),
        connections: null,
      };
    },

    async battery() {
      const battery = await system.battery();
      if (!battery) return {};
      return { percentage: battery.charge, is_charging: battery.is_charging, state: battery.is_charging ? (battery.charge >= 100 ? "full" : "charging") : "discharging", time_remaining: null, power: null, voltage: null, ac_connected: battery.is_charging };
    },

    async gpus() {
      return (await readings.gpus()).map((gpu) => ({
        id: gpu.id,
        name: gpu.name,
        core_load: gpu.busy,
        memory_used: gpu.memory_used_bytes === null ? null : round(gpu.memory_used_bytes / mib),
        memory_total: gpu.memory_total_bytes === null ? null : round(gpu.memory_total_bytes / mib),
        memory_free: gpu.memory_used_bytes === null || gpu.memory_total_bytes === null ? null : round((gpu.memory_total_bytes - gpu.memory_used_bytes) / mib),
      }));
    },

    async media() {
      const players = await system.media.list_players();
      const player = main_player(players);
      if (!player) return {};
      const status = (entry: typeof player): string => (entry.is_playing ? "PLAYING" : "PAUSED");
      return {
        status: status(player),
        title: player.title || null,
        artist: player.artist || null,
        album_title: player.album || null,
        album_artist: null,
        duration: player.length ? player.length / 1000 : null,
        position: player.position / 1000,
        updated_at: Date.now() / 1000,
        volume: player.volume / 100,
        shuffle: null,
        repeat: null,
        is_play_enabled: player.can_play,
        is_pause_enabled: player.can_pause,
        is_stop_enabled: true,
        is_next_enabled: player.can_go_next,
        is_previous_enabled: player.can_go_previous,
        is_seek_enabled: player.can_seek,
        player: player.name,
        players: players.map((entry) => ({ id: entry.name, name: entry.name, status: status(entry), title: entry.title, artist: entry.artist })),
        thumbnail: null,
      };
    },

    async processes() {
      return (await readings.processes()).map((process) => ({ id: process.id, name: process.name, status: process.status, username: process.username, memory_usage: null, cpu_usage: null, created: null, path: null, working_directory: null }));
    },

    async displays() {
      return [];
    },

    async audio() {
      const sinks = await system.volume.list_sinks();
      return { outputs: sinks.map((sink) => ({ id: sink.name, name: sink.description, volume: round((sink.volume / 65_536) * 100, 0), muted: sink.muted, default: sink.is_default })), inputs: [], apps: [] };
    },
  };

  return {
    async read(name) {
      try {
        return await builders[name]();
      } catch (error) {
        options.log?.(`System Bridge ${name}: ${error instanceof Error ? error.message : String(error)}`);
        return list_modules.has(name) ? [] : {};
      }
    },
  };
}
