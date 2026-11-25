// Battery: a device's charge as it reports it, a warning when it runs low, and this computer's own charge sent to
// every paired device whenever it moves.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { battery_manifest } from "../../shared/plugins/manifests.ts";
import type { BatteryReading } from "../system/services.ts";
import type { BatteryState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi, DeviceHandle } from "./api.ts";
import { connected_devices, number_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const battery_type = "kdeconnect.battery";
const request_type = "kdeconnect.battery.request";
const check_interval_in_milliseconds = 60_000;

function body_of(reading: BatteryReading | null): Record<string, unknown> {
  return reading ? { currentCharge: reading.charge, isCharging: reading.is_charging, thresholdEvent: 0 } : { currentCharge: -1, isCharging: false, thresholdEvent: 0 };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const battery_plugin = define_plugin<ControlPluginApi>({
  ...battery_manifest,
  start(context) {
    const devices = connected_devices();
    const { system } = context.services;
    let last: string | null = null;

    const send_own = async (to: DeviceHandle[]): Promise<void> => {
      const body = body_of(await system.battery());
      await Promise.all(to.filter((device) => device.takes(battery_type)).map((device) => device.send(battery_type, body).catch(() => undefined)));
    };

    // The computer's charge goes out only when it moved, checked once a minute.
    const timer = setInterval(async () => {
      const reading = await system.battery();
      const key = JSON.stringify(reading);
      if (key === last) return;
      last = key;
      await send_own(devices.all());
    }, check_interval_in_milliseconds);
    context.on_stop(() => clearInterval(timer));

    context.provide("capability", "battery", {
      incoming: [battery_type, request_type],
      outgoing: [battery_type, request_type],
      connected(device) {
        devices.add(device);
        return send_own([device]);
      },
      disconnected: devices.remove,
      packet(device, packet) {
        if (packet.type === request_type) return send_own([device]);
        const before = device.state<BatteryState>();
        const state: BatteryState = { charge: number_field(packet.body, "currentCharge", -1), is_charging: packet.body.isCharging === true };
        device.set_state(state);
        const low = Number(context.settings().low_level ?? 15);
        const fell_low = !state.is_charging && state.charge >= 0 && state.charge <= low && (before === undefined || before.charge > low || before.is_charging);
        if (packet.body.thresholdEvent === 1 || fell_low) {
          context.services.notify({ kind: "battery_low", key: `battery:${device.id}`, title: `${device.name}'s battery is low`, body: `${state.charge}% left.`, route: `#/devices/${device.id}` });
        }
      },
    });
  },
});
