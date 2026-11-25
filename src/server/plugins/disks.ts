// Disks: how full each mounted disk is, and how fast the disks read and write together, as LNXlink's disk usage and
// disk IO modules read them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import { disks_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi, Entity } from "./api.ts";
import { in_gib, percent, rate_tracker, shared_reading } from "./helpers.ts";

// ── Names ────────────────────────────────────────────────────────────────────

// A mount as part of an id and a name, such as "root" and "/" or "home" and "/home".
export function mount_names(mount: string): { id: string; name: string } {
  return mount === "/" ? { id: "root", name: "Disk /" } : { id: slug(mount), name: `Disk ${mount}` };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const disks_plugin = define_plugin<ControlPluginApi>({
  ...disks_manifest,
  start(context) {
    const { readings } = context.services.system;
    const disks = shared_reading(() => readings.disks());
    const counters = shared_reading(() => readings.disk_counters());
    const rate = rate_tracker();
    // Each pass reads the counters once, for both rates.
    const rates = shared_reading(async () => {
      const read = await counters();
      const now = Date.now();
      const sum = (key: "read_bytes" | "written_bytes"): number => read.reduce((total, disk) => total + disk[key], 0);
      const to_kib = (value: number | null): number | null => (value === null ? null : Math.round(value / 102.4) / 10);
      return { read: to_kib(rate("read", sum("read_bytes"), now)), written: to_kib(rate("written", sum("written_bytes"), now)), devices: read.map((disk) => disk.device) };
    });
    context.provide("entities", "disks", {
      async list() {
        const entities: Entity[] = (await disks()).map((disk) => {
          const names = mount_names(disk.mount);
          return {
            id: `${names.id}_used`,
            name: `${names.name} used`,
            kind: "sensor",
            icon: "mdi:harddisk",
            unit: "%",
            every: 60,
            read: async () => {
              const found = (await disks()).find((entry) => entry.mount === disk.mount);
              if (!found) throw new Error(`${disk.mount} is no longer mounted`);
              return { value: percent(found.total_bytes - found.free_bytes, found.total_bytes), attributes: { device: found.device, file_system: found.file_system, total_gib: in_gib(found.total_bytes), free_gib: in_gib(found.free_bytes) } };
            },
          };
        });
        entities.push(
          { id: "read_rate", name: "Disks reading", kind: "sensor", icon: "mdi:harddisk-plus", unit: "kB/s", device_class: "data_rate", read: async () => { const read = await rates(); return { value: read.read, attributes: { disks: read.devices } }; } },
          { id: "write_rate", name: "Disks writing", kind: "sensor", icon: "mdi:harddisk-remove", unit: "kB/s", device_class: "data_rate", read: async () => (await rates()).written },
        );
        return entities;
      },
    });
  },
});
