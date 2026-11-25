import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  bus_id,
  busy_between,
  idle_from_loginctl,
  read_brightnessctl,
  read_diskstats,
  read_hwmon,
  read_meminfo,
  read_mounts,
  read_net_dev,
  read_nvidia_smi,
  read_power_profiles,
  read_os_release,
  read_proc_stat,
  read_process_status,
  read_wireless,
  streams_running,
} from "../src/server/system/linux_readings.ts";

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("processor and memory", () => {
  test("works out how busy the processor was between two readings of /proc/stat", () => {
    const before = read_proc_stat("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0\nintr 1\n");
    const after = read_proc_stat("cpu  200 0 200 1300 100 0 0 0 0 0\ncpu0 150 0 100 400 50 0 0 0 0 0\ncpu1 50 0 100 900 50 0 0 0 0 0\n");
    expect(after.cores).toHaveLength(2);
    expect(busy_between(before.all, after.all)).toBe(25);
    expect(busy_between(before.cores[0]!, after.cores[0]!)).toBe(75);
    expect(busy_between(after.all, after.all)).toBe(0);
  });

  test("reads memory and swap in bytes", () => {
    const memory = read_meminfo("MemTotal:       16000000 kB\nMemFree:  1000 kB\nMemAvailable:    8000000 kB\nSwapTotal: 4000 kB\nSwapFree: 1000 kB\n");
    expect(memory).toEqual({ total_bytes: 16_000_000 * 1024, available_bytes: 8_000_000 * 1024, swap_total_bytes: 4000 * 1024, swap_free_bytes: 1000 * 1024 });
  });
});

describe("disks and network", () => {
  test("keeps one mount for each disk and leaves out what is not a disk", () => {
    const mounts = read_mounts(
      ["/dev/nvme0n1p2 / btrfs rw 0 0", "proc /proc proc rw 0 0", "/dev/nvme0n1p2 /home btrfs rw 0 0", "/dev/nvme0n1p1 /boot vfat rw 0 0", "tmpfs /run tmpfs rw 0 0", "/dev/sdb1 /media/My\\040Disk ext4 rw 0 0"].join("\n"),
    );
    expect(mounts).toEqual([
      { device: "/dev/nvme0n1p2", mount: "/", file_system: "btrfs" },
      { device: "/dev/nvme0n1p1", mount: "/boot", file_system: "vfat" },
      { device: "/dev/sdb1", mount: "/media/My Disk", file_system: "ext4" },
    ]);
  });

  test("reads whole disks' bytes from /proc/diskstats", () => {
    const text = " 259       0 nvme0n1 20 261 1000 4 5 906 2000 1 0 4 7\n 259       1 nvme0n1p1 1 2 30 4 5 6 70 8 0 4 1\n   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0\n";
    expect(read_diskstats(text, ["nvme0n1"])).toEqual([{ device: "nvme0n1", read_bytes: 1000 * 512, written_bytes: 2000 * 512 }]);
  });

  test("reads each interface's bytes and the wireless signal", () => {
    const dev = "Inter-|   Receive\n face |bytes\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eth0: 5000 10 0 0 0 0 0 0 700 5 0 0 0 0 0 0\n";
    expect(read_net_dev(dev).get("eth0")).toEqual({ received_bytes: 5000, sent_bytes: 700 });
    const wireless = "Inter-| sta-|   Quality\n face | tus | link level noise\n  wlo1: 0000   65.  -45.  -256        0      0      0    528      2        0\n";
    expect(read_wireless(wireless)).toEqual({ interface: "wlo1", signal_dbm: -45 });
    expect(read_wireless("header\nheader\n")).toBeNull();
  });
});

describe("temperatures and graphics", () => {
  test("reads each hwmon sensor with its label", () => {
    const folder = mkdtempSync(join(tmpdir(), "x-control-hwmon-"));
    folders.push(folder);
    mkdirSync(join(folder, "hwmon0"));
    writeFileSync(join(folder, "hwmon0", "name"), "k10temp\n");
    writeFileSync(join(folder, "hwmon0", "temp1_input"), "45250\n");
    writeFileSync(join(folder, "hwmon0", "temp1_label"), "Tctl\n");
    mkdirSync(join(folder, "hwmon1"));
    writeFileSync(join(folder, "hwmon1", "name"), "nvme\n");
    writeFileSync(join(folder, "hwmon1", "temp1_input"), "");
    writeFileSync(join(folder, "hwmon1", "temp2_input"), "38000");
    expect(read_hwmon(folder)).toEqual([
      { id: "k10temp_tctl", label: "k10temp Tctl", celsius: 45.3 },
      { id: "nvme_temp2", label: "nvme temp2", celsius: 38 },
    ]);
  });

  test("tells two chips of the same name apart by their device", () => {
    const folder = mkdtempSync(join(tmpdir(), "x-control-hwmon-"));
    folders.push(folder);
    for (const [hwmon, device] of [["hwmon1", "nvme0"], ["hwmon2", "nvme1"]] as const) {
      mkdirSync(join(folder, "devices", device), { recursive: true });
      mkdirSync(join(folder, hwmon));
      symlinkSync(join(folder, "devices", device), join(folder, hwmon, "device"));
      writeFileSync(join(folder, hwmon, "name"), "nvme\n");
      writeFileSync(join(folder, hwmon, "temp1_input"), "40000\n");
      writeFileSync(join(folder, hwmon, "temp1_label"), "Composite\n");
    }
    mkdirSync(join(folder, "devices", "unused"));
    expect(read_hwmon(folder).map((sensor) => sensor.id).sort()).toEqual(["nvme0_composite", "nvme1_composite"]);
  });

  test("reads nvidia-smi's lines", () => {
    expect(read_nvidia_smi("0, NVIDIA GeForce RTX 3050, 3, 14, 4096, 00000000:01:00.0\n")[0]?.id).toBe("nvidia_01_00_0");
    expect(bus_id("0000:01:00.0")).toBe("01_00_0");
    expect(read_nvidia_smi("0, NVIDIA GeForce GTX 1650, 12, 512, 4096\n")).toEqual([{ id: "nvidia0", name: "NVIDIA GeForce GTX 1650", busy: 12, memory_used_bytes: 512 * 1024 ** 2, memory_total_bytes: 4096 * 1024 ** 2 }]);
    expect(read_nvidia_smi("0, GPU, [N/A], [N/A], 4096")[0]).toMatchObject({ busy: null, memory_used_bytes: null });
  });
});

describe("session and power", () => {
  test("says whether any stream is running", () => {
    expect(streams_running(JSON.stringify([{ corked: true }, { corked: false }]))).toBe(true);
    expect(streams_running("[]")).toBe(false);
    expect(streams_running("not json")).toBe(false);
  });

  test("reads logind's idle hint", () => {
    const now = 1_700_000_100_000;
    expect(idle_from_loginctl(`IdleHint=yes\nIdleSinceHint=${(now - 90_000) * 1000}\n`, now)).toBe(90);
    expect(idle_from_loginctl("IdleHint=no\nIdleSinceHint=0\n", now)).toBe(0);
    expect(idle_from_loginctl("", now)).toBeNull();
  });

  test("reads power profiles and brightness", () => {
    expect(read_power_profiles("  performance:\n    Driver: amd\n\n* balanced:\n    Driver: amd\n\n  power-saver:\n    Driver: amd\n")).toEqual({ active: "balanced", available: ["performance", "balanced", "power-saver"] });
    expect(read_power_profiles("")).toBeNull();
    expect(read_brightnessctl("intel_backlight,backlight,500,50%,1000\n")).toBe(50);
    expect(read_brightnessctl("")).toBeNull();
  });
});

describe("system", () => {
  test("reads a process's status and the distribution's version", () => {
    const status = "Name:\tfirefox\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t  204800 kB\n";
    expect(read_process_status(42, status, (uid) => (uid === 1000 ? "me" : null))).toEqual({ id: 42, name: "firefox", status: "sleeping", username: "me", memory_bytes: 204800 * 1024 });
    expect(read_process_status(2, "Name:\tkthreadd\nState:\tS (sleeping)\nUid:\t0\t0\t0\t0\n", () => null)).toMatchObject({ username: null, memory_bytes: null });
    expect(read_os_release('NAME=NixOS\nVERSION_ID="26.11"\n')).toBe("26.11");
    expect(read_os_release("")).toBe("");
  });
});
