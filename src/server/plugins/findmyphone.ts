// Find my device: ring a device to find it, and ring this computer when a device asks.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { findmyphone_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi } from "./api.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

const request_type = "kdeconnect.findmyphone.request";

export const findmyphone_plugin = define_plugin<ControlPluginApi>({
  ...findmyphone_manifest,
  start(context) {
    context.provide("capability", "findmyphone", {
      incoming: [request_type],
      outgoing: [request_type],
      async packet(device) {
        context.services.notify({ kind: "find_my_device", key: "find_my_device", title: "Here I am", body: `${device.name} is looking for this computer.`, urgency: "critical" });
        await context.services.system.ring();
      },
      actions: {
        ring: { label: "Ring", description: "Rings the device loudly, even when it is silenced, so it can be found.", needs: request_type, run: (device) => device.send(request_type, {}) },
      },
    });
  },
});
