// Services: a switch for each systemd unit named in the plugin's settings, on while it runs, as LNXlink's systemd
// module offers them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import { system_services_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi, Entity } from "./api.ts";
import { names_in } from "./helpers.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const system_services_plugin = define_plugin<ControlPluginApi>({
  ...system_services_manifest,
  start(context) {
    const { units } = context.services.system;
    const switch_for = (unit: string, user: boolean): Entity => ({
      id: `${user ? "user_" : ""}${slug(unit)}`,
      name: user ? `${unit} (yours)` : unit,
      kind: "switch",
      icon: "mdi:cog-play",
      read: async () => {
        const state = await units.state(unit, user);
        return { value: state === "active" || state === "reloading" || state === "activating", attributes: { state, scope: user ? "user" : "system" } };
      },
      set: (running) => units.set_running(unit, user, running === true),
    });
    context.provide("entities", "services", {
      list: () => [...names_in(context.settings().system_units).map((unit) => switch_for(unit, false)), ...names_in(context.settings().user_units).map((unit) => switch_for(unit, true))],
    });
  },
});
