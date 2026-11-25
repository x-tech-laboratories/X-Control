// Temperatures: each temperature sensor the kernel lists, such as the processor package or an NVMe disk, as LNXlink's
// temperature module reads them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import { temperatures_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi } from "./api.ts";
import { shared_reading } from "./helpers.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const temperatures_plugin = define_plugin<ControlPluginApi>({
  ...temperatures_manifest,
  start(context) {
    const temperatures = shared_reading(() => context.services.system.readings.temperatures());
    context.provide("entities", "temperatures", {
      list: async () =>
        (await temperatures()).map((sensor) => ({
          id: slug(sensor.id),
          name: sensor.label,
          kind: "sensor" as const,
          icon: "mdi:thermometer",
          unit: "°C",
          device_class: "temperature",
          read: async () => {
            const found = (await temperatures()).find((entry) => entry.id === sensor.id);
            if (!found) throw new Error(`${sensor.label} is gone`);
            return found.celsius;
          },
        })),
    });
  },
});
