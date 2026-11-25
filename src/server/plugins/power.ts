// Power: this computer's battery, buttons to shut it down, restart, suspend or hibernate it, a switch keeping it awake,
// and its power profile and screen brightness, as LNXlink's battery, shutdown, restart, suspend, keep alive, power
// profile and brightness modules offer them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { power_manifest } from "../../shared/plugins/manifests.ts";
import type { PowerAction } from "../system/services.ts";
import type { ControlPluginApi, Entity } from "./api.ts";

// ── Buttons ──────────────────────────────────────────────────────────────────

const buttons: { action: PowerAction; name: string; icon: string }[] = [
  { action: "shutdown", name: "Shut down", icon: "mdi:power" },
  { action: "restart", name: "Restart", icon: "mdi:restart" },
  { action: "suspend", name: "Suspend", icon: "mdi:power-sleep" },
  { action: "hibernate", name: "Hibernate", icon: "mdi:power-cycle" },
];

// ── Plugin ───────────────────────────────────────────────────────────────────

export const power_plugin = define_plugin<ControlPluginApi>({
  ...power_manifest,
  start(context) {
    const { system } = context.services;
    const { power } = system;
    // A switch left on would hold the inhibitor after the plugin is gone.
    context.on_stop(() => (power.is_kept_awake() ? power.keep_awake(false) : undefined));
    context.provide("entities", "power", {
      async list() {
        const entities: Entity[] = buttons.map((button) => ({
          id: button.action,
          name: button.name,
          kind: "button",
          icon: button.icon,
          set: async () => {
            context.services.log(`${button.name} asked for`);
            await power.act(button.action);
          },
        }));
        entities.push({ id: "keep_awake", name: "Keep awake", kind: "switch", icon: "mdi:coffee", read: () => power.is_kept_awake(), set: (on) => power.keep_awake(on === true) });
        const [battery, profiles, brightness] = await Promise.all([system.battery().catch(() => null), power.profiles().catch(() => null), power.brightness().catch(() => null)]);
        if (battery) {
          entities.push(
            { id: "battery", name: "Battery", kind: "sensor", unit: "%", device_class: "battery", read: async () => (await system.battery())?.charge ?? null },
            { id: "charging", name: "Charging", kind: "binary_sensor", device_class: "battery_charging", read: async () => (await system.battery())?.is_charging ?? null },
          );
        }
        if (profiles) {
          entities.push({ id: "profile", name: "Power profile", kind: "select", icon: "mdi:leaf", category: "config", options: profiles.available, read: async () => (await power.profiles())?.active ?? null, set: (name) => power.set_profile(String(name)) });
        }
        if (brightness !== null) {
          entities.push({ id: "brightness", name: "Screen brightness", kind: "number", icon: "mdi:brightness-6", unit: "%", min: 1, max: 100, step: 1, read: () => power.brightness(), set: (percent) => power.set_brightness(Number(percent)) });
        }
        return entities;
      },
    });
  },
});
