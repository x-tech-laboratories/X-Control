// The readings and power controls of a Linux computer: /proc and /sys for the processor, memory, disks, network and
// temperatures, and logind, power-profiles-daemon, brightnessctl and systemd for what Node cannot read itself.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { hostname, networkInterfaces, release, uptime, userInfo } from "node:os";
import { join } from "node:path";

import { run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import { output_of } from "./linux.ts";
import type { ProcessReading, SystemInfo, ComputerReadings, CpuReading, DiskCounters, DiskReading, GpuReading, MemoryReading, PowerServices, TemperatureReading, UnitServices, WifiReading } from "./services.ts";

// ── Files ────────────────────────────────────────────────────────────────────

function read_text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function list_folder(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// ── Processor ────────────────────────────────────────────────────────────────

// The time a processor has spent, and how much of it idle, in clock ticks.
export interface CpuTimes {
  total: number;
  idle: number;
}

// The overall and per-core times in /proc/stat.
export function read_proc_stat(text: string): { all: CpuTimes; cores: CpuTimes[] } {
  const times = (line: string): CpuTimes => {
    const numbers = line.trim().split(/\s+/).slice(1).map(Number);
    // idle and iowait are the time it waited.
    const idle = (numbers[3] ?? 0) + (numbers[4] ?? 0);
    return { total: numbers.slice(0, 8).reduce((sum, value) => sum + value, 0), idle };
  };
  const lines = text.split("\n");
  const all = lines.find((line) => line.startsWith("cpu "));
  return { all: all ? times(all) : { total: 0, idle: 0 }, cores: lines.filter((line) => /^cpu\d+ /.test(line)).map(times) };
}

// How busy, from 0 to 100, between two readings of the same processor.
export function busy_between(before: CpuTimes, after: CpuTimes): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.round(((total - (after.idle - before.idle)) / total) * 1000) / 10;
}

function cpu_model(): string {
  const line = read_text("/proc/cpuinfo").split("\n").find((entry) => /^(model name|Hardware)\s*:/.test(entry));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

// ── Memory ───────────────────────────────────────────────────────────────────

export function read_meminfo(text: string): MemoryReading {
  const values = new Map(text.split("\n").map((line) => {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    return match ? [match[1]!, Number(match[2]) * 1024] : ["", 0];
  }));
  const value = (key: string): number => values.get(key) ?? 0;
  return { total_bytes: value("MemTotal"), available_bytes: value("MemAvailable"), swap_total_bytes: value("SwapTotal"), swap_free_bytes: value("SwapFree") };
}

// ── Disks ────────────────────────────────────────────────────────────────────

// File systems on disks or shares; tmpfs, proc, overlays and the like are left out.
const disk_file_systems = new Set(["ext2", "ext3", "ext4", "btrfs", "xfs", "zfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "nfs", "nfs4", "cifs", "bcachefs", "jfs", "reiserfs"]);

// The mounts of /proc/mounts worth reading, one for each device, so btrfs subvolumes and bind mounts show once.
export function read_mounts(text: string): { mount: string; device: string; file_system: string }[] {
  const seen = new Set<string>();
  const found: { mount: string; device: string; file_system: string }[] = [];
  for (const line of text.split("\n")) {
    const [device, mount, file_system] = line.split(" ");
    if (!device || !mount || !file_system || !disk_file_systems.has(file_system) || seen.has(device)) continue;
    seen.add(device);
    // /proc/mounts writes spaces in paths as \\040.
    found.push({ device, mount: mount.replace(/\\040/g, " "), file_system });
  }
  return found;
}

// Bytes read and written by each whole disk named, from /proc/diskstats, whose sectors are 512 bytes.
export function read_diskstats(text: string, disks: string[]): DiskCounters[] {
  return text.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const device = fields[2];
    if (!device || !disks.includes(device)) return [];
    return [{ device, read_bytes: Number(fields[5]) * 512, written_bytes: Number(fields[9]) * 512 }];
  });
}

// Whole disks, leaving out loop devices and memory disks.
function whole_disks(): string[] {
  return list_folder("/sys/block").filter((name) => !/^(loop|ram|zram|dm-|sr)/.test(name));
}

// ── Network ──────────────────────────────────────────────────────────────────

// Bytes received and sent by each interface in /proc/net/dev.
export function read_net_dev(text: string): Map<string, { received_bytes: number; sent_bytes: number }> {
  const found = new Map<string, { received_bytes: number; sent_bytes: number }>();
  for (const line of text.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!name || !rest) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    found.set(name.trim(), { received_bytes: fields[0] ?? 0, sent_bytes: fields[8] ?? 0 });
  }
  return found;
}

// The first wireless card's signal in /proc/net/wireless.
export function read_wireless(text: string): { interface: string; signal_dbm: number | null } | null {
  const line = text.split("\n").slice(2).find((entry) => entry.includes(":"));
  if (!line) return null;
  const [name, rest = ""] = line.split(":");
  const level = Number.parseFloat(rest.trim().split(/\s+/)[2] ?? "");
  return { interface: name!.trim(), signal_dbm: Number.isFinite(level) ? level : null };
}

// ── Temperatures ─────────────────────────────────────────────────────────────

// Each sensor of each chip; two chips of the same name, such as two NVMe disks, are told apart by their device.
export function read_hwmon(folder = "/sys/class/hwmon"): TemperatureReading[] {
  const folders = list_folder(folder);
  const names = folders.map((hwmon) => read_text(join(folder, hwmon, "name")).trim() || hwmon);
  return folders.flatMap((hwmon, index) => {
    const base = join(folder, hwmon);
    const name = names[index]!;
    const repeated = names.filter((other) => other === name).length > 1;
    const chip = repeated ? device_name(join(base, "device")) ?? `${name} ${hwmon}` : name;
    return list_folder(base)
      .filter((file) => /^temp\d+_input$/.test(file))
      .flatMap((file) => {
        const text = read_text(join(base, file)).trim();
        const millidegrees = Number(text);
        if (text === "" || !Number.isFinite(millidegrees)) return [];
        const label = read_text(join(base, file.replace("_input", "_label"))).trim() || file.replace("_input", "");
        return [{ id: `${chip}_${label}`.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: `${chip} ${label}`, celsius: Math.round(millidegrees / 100) / 10 }];
      });
  });
}

// The name of the device a sysfs link points at, such as "nvme0".
function device_name(link: string): string | null {
  try {
    return realpathSync(link).split("/").at(-1) ?? null;
  } catch {
    return null;
  }
}

// ── Graphics ─────────────────────────────────────────────────────────────────

// A PCI address as part of an id, the same from nvidia-smi ("00000000:01:00.0") and from /sys ("0000:01:00.0").
export function bus_id(address: string): string {
  return address.trim().slice(-7).toLowerCase().replace(/[^0-9a-f]+/g, "_");
}

// nvidia-smi's CSV lines of index, name, busy, memory used and total in MiB, and PCI address.
export function read_nvidia_smi(text: string): GpuReading[] {
  return text.split("\n").filter(Boolean).map((line) => {
    const [index = "0", name = "NVIDIA", busy, used, total, address] = line.split(",").map((field) => field.trim());
    const mebibytes = (value: string | undefined): number | null => (value && Number.isFinite(Number(value)) ? Number(value) * 1024 * 1024 : null);
    return { id: address ? `nvidia_${bus_id(address)}` : `nvidia${index}`, name, busy: busy && Number.isFinite(Number(busy)) ? Number(busy) : null, memory_used_bytes: mebibytes(used), memory_total_bytes: mebibytes(total) };
  });
}

// NVIDIA cards and whether the kernel has put each to sleep, as a laptop does with its second card.
function nvidia_cards(folder = "/sys/bus/pci/drivers/nvidia"): { address: string; asleep: boolean }[] {
  return list_folder(folder)
    .filter((name) => /^[0-9a-f]{4}:/.test(name))
    .map((address) => ({ address, asleep: read_text(join(folder, address, "power", "runtime_status")).trim() === "suspended" }));
}

// NVIDIA cards through nvidia-smi, which would wake a sleeping card, so one asleep is told as idle from what was last read.
function nvidia_reader(): () => Promise<GpuReading[]> {
  const known = new Map<string, GpuReading>();
  return async () => {
    const cards = nvidia_cards();
    if (cards.length === 0) return [];
    if (cards.every((card) => card.asleep)) {
      return cards.map((card) => {
        const id = `nvidia_${bus_id(card.address)}`;
        return { id, name: known.get(id)?.name ?? "NVIDIA", busy: 0, memory_used_bytes: 0, memory_total_bytes: known.get(id)?.memory_total_bytes ?? null };
      });
    }
    const read = read_nvidia_smi(await output_of(["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,pci.bus_id", "--format=csv,noheader,nounits"]).catch(() => ""));
    for (const gpu of read) known.set(gpu.id, gpu);
    return read;
  };
}

// Cards whose driver says how busy they are, as amdgpu does.
function sysfs_gpus(): GpuReading[] {
  return list_folder("/sys/class/drm").filter((name) => /^card\d+$/.test(name)).flatMap((card) => {
    const device = join("/sys/class/drm", card, "device");
    const busy = read_text(join(device, "gpu_busy_percent")).trim();
    if (!busy) return [];
    const number_or_null = (file: string): number | null => {
      const text = read_text(join(device, file)).trim();
      return text ? Number(text) : null;
    };
    const driver = /DRIVER=(\S+)/.exec(read_text(join(device, "uevent")))?.[1] ?? card;
    return [{ id: card, name: driver, busy: Number(busy), memory_used_bytes: number_or_null("mem_info_vram_used"), memory_total_bytes: number_or_null("mem_info_vram_total") }];
  });
}

// ── Session ──────────────────────────────────────────────────────────────────

// Whether any process this user can see holds a camera open.
function camera_in_use(): boolean {
  for (const pid of list_folder("/proc").filter((name) => /^\d+$/.test(name))) {
    for (const fd of list_folder(`/proc/${pid}/fd`)) {
      try {
        if (/^\/dev\/video\d+$/.test(readlinkSync(`/proc/${pid}/fd/${fd}`))) return true;
      } catch {
        // The process ended, or belongs to someone else.
      }
    }
  }
  return false;
}

// Whether any stream in pactl's JSON list is playing or recording now.
export function streams_running(json: string): boolean {
  try {
    const streams = JSON.parse(json) as { corked?: boolean }[];
    return streams.some((stream) => stream.corked === false);
  } catch {
    return false;
  }
}

// logind's idle hint: when the session went idle, in microseconds since 1970.
export function idle_from_loginctl(text: string, now_ms: number): number | null {
  const values = Object.fromEntries(text.split("\n").map((line) => line.split("=") as [string, string]));
  if (values.IdleHint === undefined) return null;
  if (values.IdleHint !== "yes") return 0;
  const since = Number(values.IdleSinceHint) / 1000;
  return since > 0 ? Math.max(0, Math.round((now_ms - since) / 1000)) : null;
}

// A new kernel or its modules waits for a restart: Debian's flag file, or NixOS's booted system differing from the current one.
function restart_needed(): boolean {
  if (existsSync("/var/run/reboot-required")) return true;
  try {
    return ["kernel", "initrd", "kernel-modules"].some((part) => realpathSync(`/run/booted-system/${part}`) !== realpathSync(`/run/current-system/${part}`));
  } catch {
    return false;
  }
}

// ── System ───────────────────────────────────────────────────────────────────

// A process's name, state, owner and memory from /proc/<pid>/status.
export function read_process_status(pid: number, text: string, user_of: (uid: number) => string | null): ProcessReading {
  const field = (key: string): string | null => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;
  const memory = /^(\d+)/.exec(field("VmRSS") ?? "")?.[1];
  const uid = Number((field("Uid") ?? "").split(/\s+/)[0]);
  return { id: pid, name: field("Name") ?? String(pid), status: field("State")?.replace(/^\S+\s*\((.*)\)$/, "$1") ?? null, username: Number.isFinite(uid) ? user_of(uid) : null, memory_bytes: memory ? Number(memory) * 1024 : null };
}

export function read_os_release(text: string): string {
  return /^VERSION_ID="?([^"\n]*)"?$/m.exec(text)?.[1] ?? "";
}

function dmi(name: string): string | null {
  return read_text(`/sys/class/dmi/id/${name}`).trim() || null;
}

// ── Readings ─────────────────────────────────────────────────────────────────

export function linux_readings(): ComputerReadings {
  let last_stat = read_proc_stat(read_text("/proc/stat"));
  const model = cpu_model();
  const nvidia = nvidia_reader();
  const me = userInfo();
  const user_of = (uid: number): string | null => (uid === me.uid ? me.username : uid === 0 ? "root" : null);
  return {
    system_info: async (): Promise<SystemInfo> => ({
      hostname: hostname(),
      kernel_version: release(),
      platform_version: read_os_release(read_text("/etc/os-release")),
      device: { manufacturer: dmi("sys_vendor"), model: dmi("product_name"), version: dmi("product_version"), board_vendor: dmi("board_vendor"), board_name: dmi("board_name"), bios_vendor: dmi("bios_vendor"), bios_version: dmi("bios_version"), chassis_type: dmi("chassis_type") },
    }),
    processes: async () =>
      list_folder("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
        const text = read_text(`/proc/${name}/status`);
        return text ? [read_process_status(Number(name), text, user_of)] : [];
      }),
    cpu: async (): Promise<CpuReading> => {
      const stat = read_proc_stat(read_text("/proc/stat"));
      const before = last_stat;
      last_stat = stat;
      const load = read_text("/proc/loadavg").split(" ").slice(0, 3).map(Number) as [number, number, number];
      return {
        busy: busy_between(before.all, stat.all),
        cores_busy: stat.cores.map((core, index) => busy_between(before.cores[index] ?? core, core)),
        load,
        cores: stat.cores.length,
        model,
      };
    },
    memory: async () => read_meminfo(read_text("/proc/meminfo")),
    disks: async (): Promise<DiskReading[]> => {
      const mounts = read_mounts(read_text("/proc/mounts"));
      const read = await Promise.all(mounts.map(async (entry) => {
        try {
          const stats = await statfs(entry.mount);
          return [{ ...entry, total_bytes: stats.blocks * stats.bsize, free_bytes: stats.bavail * stats.bsize }];
        } catch {
          return [];
        }
      }));
      return read.flat();
    },
    disk_counters: async () => read_diskstats(read_text("/proc/diskstats"), whole_disks()),
    interfaces: async () => {
      const counters = read_net_dev(read_text("/proc/net/dev"));
      const addresses = networkInterfaces();
      return [...counters].filter(([name]) => name !== "lo").map(([name, counted]) => ({
        name,
        is_up: read_text(`/sys/class/net/${name}/operstate`).trim() === "up",
        addresses: (addresses[name] ?? []).filter((address) => !address.internal).map((address) => address.address),
        ...counted,
      }));
    },
    wifi: async (): Promise<WifiReading | null> => {
      const card = read_wireless(read_text("/proc/net/wireless"));
      if (!card) return null;
      const active = (await output_of(["nmcli", "-t", "-f", "active,ssid", "device", "wifi"]).catch(() => "")).split("\n").find((line) => line.startsWith("yes:"));
      return { ...card, network: active ? active.slice(4).replace(/\\:/g, ":") : null };
    },
    temperatures: async () => read_hwmon(),
    gpus: async () => [...sysfs_gpus(), ...(await nvidia())],
    uptime: async () => Math.round(uptime()),
    restart_needed: async () => restart_needed(),
    user: () => userInfo().username,
    devices_in_use: async () => {
      const [recording, playing] = await Promise.all([
        output_of(["pactl", "--format=json", "list", "source-outputs"]).catch(() => "[]"),
        output_of(["pactl", "--format=json", "list", "sink-inputs"]).catch(() => "[]"),
      ]);
      return { camera: camera_in_use(), microphone: streams_running(recording), speakers: streams_running(playing) };
    },
    idle_seconds: async () => {
      const text = await output_of(["loginctl", "show-session", process.env.XDG_SESSION_ID ?? "auto", "-p", "IdleHint", "-p", "IdleSinceHint"]).catch(() => "");
      return idle_from_loginctl(text, Date.now());
    },
  };
}

// ── Power ────────────────────────────────────────────────────────────────────

// powerprofilesctl list's profiles, the active one marked with a star.
export function read_power_profiles(text: string): { active: string; available: string[] } | null {
  const lines = text.split("\n").filter((line) => /^\s*\*?\s*[\w-]+:\s*$/.test(line));
  if (lines.length === 0) return null;
  const name = (line: string): string => line.replace("*", "").replace(":", "").trim();
  const active = lines.find((line) => line.trim().startsWith("*"));
  return { active: active ? name(active) : name(lines[0]!), available: lines.map(name) };
}

// brightnessctl -m's line of device, class, value, percentage and maximum.
export function read_brightnessctl(text: string): number | null {
  const percent = /,(\d+)%,/.exec(text);
  return percent ? Number(percent[1]) : null;
}

export function linux_power(): PowerServices {
  let inhibitor: AbortController | null = null;
  return {
    act: async (action) => {
      const verbs = { shutdown: "poweroff", restart: "reboot", suspend: "suspend", hibernate: "hibernate" };
      await output_of(["systemctl", verbs[action]]);
    },
    profiles: async () => read_power_profiles(await output_of(["powerprofilesctl", "list"]).catch(() => "")),
    set_profile: async (name) => void (await output_of(["powerprofilesctl", "set", name])),
    brightness: async () => read_brightnessctl(await output_of(["brightnessctl", "-m"]).catch(() => "")),
    set_brightness: async (percent) => void (await output_of(["brightnessctl", "set", `${Math.max(1, Math.min(100, Math.round(percent)))}%`])),
    // systemd-inhibit holds the lock for as long as its sleep runs.
    keep_awake: async (on) => {
      inhibitor?.abort();
      inhibitor = null;
      if (!on) return;
      const controller = new AbortController();
      inhibitor = controller;
      void run_program(["systemd-inhibit", "--what=idle:sleep", "--who=X-Control", "--why=Kept awake from Home Assistant or X-Control", "sleep", "infinity"], { signal: controller.signal, stdout: "drop", stderr: "drop" }).finally(() => {
        if (inhibitor === controller) inhibitor = null;
      });
    },
    is_kept_awake: () => inhibitor !== null,
  };
}

// ── Units ────────────────────────────────────────────────────────────────────

export function linux_units(): UnitServices {
  const scope = (user: boolean): string[] => (user ? ["--user"] : []);
  return {
    state: async (unit, user) => {
      const result = await run_program(["systemctl", ...scope(user), "is-active", unit], { stdout: "keep", stderr: "drop" });
      return result.stdout.trim() || "unknown";
    },
    set_running: async (unit, user, running) => void (await output_of(["systemctl", ...scope(user), running ? "start" : "stop", unit])),
  };
}
