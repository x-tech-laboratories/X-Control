// Ping: a device says hello, and this one shows it; the page can ping a device back.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { ping_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi } from "./api.ts";
import { text_field } from "./helpers.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

const ping_type = "kdeconnect.ping";

export const ping_plugin = define_plugin<ControlPluginApi>({
  ...ping_manifest,
  start(context) {
    context.provide("capability", "ping", {
      incoming: [ping_type],
      outgoing: [ping_type],
      packet(device, packet) {
        const message = text_field(packet.body, "message");
        context.services.notify({ kind: "ping", key: `ping:${device.id}`, title: device.name, body: message || "Ping!", route: `#/devices/${device.id}` });
      },
      actions: {
        send: {
          label: "Ping",
          description: "Pings the device, which shows a notification.",
          params: [{ name: "message", schema: { type: "string", description: "Words to show instead of Ping!." }, optional: true }],
          needs: ping_type,
          run: (device, args) => device.send(ping_type, typeof args.message === "string" && args.message ? { message: args.message } : {}),
        },
      },
    });
  },
});
