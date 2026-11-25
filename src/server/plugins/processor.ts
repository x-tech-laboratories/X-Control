// Processor and memory: how busy the processor and graphics cards are, the load, memory and swap in use, and when
// the computer started, as LNXlink's cpu, gpu, memory and boot time modules read them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import { processor_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi, Entity } from "./api.ts";
import { in_gib, percent, shared_reading } from "./helpers.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const processor_plugin = define_plugin<ControlPluginApi>({
  ...processor_manifest,
  start(context) {
    const { readings: computer } = context.services.system;
    const readings = { ...computer, cpu: shared_reading(() => computer.cpu()), gpus: shared_reading(() => computer.gpus()), memory: shared_reading(() => computer.memory()) };
    context.provide("entities", "processor", {
      async list() {
        const gpus = await readings.gpus().catch(() => []);
        const memory = await readings.memory();
        const entities: Entity[] = [
          {
            id: "usage",
            name: "Processor usage",
            kind: "sensor",
            icon: "mdi:speedometer",
            unit: "%",
            read: async () => {
              const cpu = await readings.cpu();
              return { value: cpu.busy, attributes: { model: cpu.model, cores: cpu.cores, cores_busy: cpu.cores_busy } };
            },
          },
          {
            id: "load",
            name: "Load average",
            kind: "sensor",
            icon: "mdi:cpu-64-bit",
            read: async () => {
              const { load, cores } = await readings.cpu();
              return { value: load[0], attributes: { load_5_minutes: load[1], load_15_minutes: load[2], load_percent: percent(load[0], cores) } };
            },
          },
          {
            id: "memory",
            name: "Memory used",
            kind: "sensor",
            icon: "mdi:memory",
            unit: "%",
            read: async () => {
              const read = await readings.memory();
              return { value: percent(read.total_bytes - read.available_bytes, read.total_bytes), attributes: { total_gib: in_gib(read.total_bytes), available_gib: in_gib(read.available_bytes) } };
            },
          },
          {
            id: "booted",
            name: "Started",
            kind: "sensor",
            icon: "mdi:clock-start",
            device_class: "timestamp",
            category: "diagnostic",
            every: 300,
            // To the minute, so it does not wobble between readings.
            read: async () => new Date(Math.round((Date.now() - (await readings.uptime()) * 1000) / 60_000) * 60_000).toISOString(),
          },
          { id: "restart_needed", name: "Restart needed", kind: "binary_sensor", icon: "mdi:restart-alert", device_class: "update", category: "diagnostic", every: 300, read: () => readings.restart_needed() },
        ];
        if (memory.swap_total_bytes > 0) {
          entities.push({
            id: "swap",
            name: "Swap used",
            kind: "sensor",
            icon: "mdi:harddisk",
            unit: "%",
            read: async () => {
              const read = await readings.memory();
              return percent(read.swap_total_bytes - read.swap_free_bytes, read.swap_total_bytes);
            },
          });
        }
        for (const gpu of gpus) {
          const find = async () => {
            const found = (await readings.gpus()).find((entry) => entry.id === gpu.id);
            if (!found) throw new Error(`${gpu.name} is gone`);
            return found;
          };
          entities.push({ id: `gpu_${slug(gpu.id)}`, name: `Graphics ${gpu.name} usage`, kind: "sensor", icon: "mdi:expansion-card", unit: "%", read: async () => (await find()).busy });
          if (gpu.memory_total_bytes) {
            entities.push({
              id: `gpu_${slug(gpu.id)}_memory`,
              name: `Graphics ${gpu.name} memory used`,
              kind: "sensor",
              icon: "mdi:expansion-card-variant",
              unit: "%",
              read: async () => {
                const found = await find();
                return { value: found.memory_used_bytes === null || !found.memory_total_bytes ? null : percent(found.memory_used_bytes, found.memory_total_bytes), attributes: { used_gib: in_gib(found.memory_used_bytes ?? 0), total_gib: in_gib(found.memory_total_bytes ?? 0) } };
              },
            });
          }
        }
        return entities;
      },
    });
  },
});
