// Clipboard: what is copied on this computer goes to every paired device, and what a device copies lands here, each
// way behind its own switch. A device that connects is sent the clipboard with when it was copied, and keeps the newer.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { clipboard_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi, DeviceHandle } from "./api.ts";
import { connected_devices, number_field, text_arg, text_field } from "./helpers.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

const clipboard_type = "kdeconnect.clipboard";
const connect_type = "kdeconnect.clipboard.connect";
const watch_interval_in_milliseconds = 1000;

export const clipboard_plugin = define_plugin<ControlPluginApi>({
  ...clipboard_manifest,
  async start(context) {
    const devices = connected_devices();
    const { clipboard } = context.services.system;
    // What the clipboard holds and when it last changed, in milliseconds.
    let content = (await clipboard.read()) ?? "";
    let changed_at = 0;
    let watching = false;

    const send_to = async (targets: DeviceHandle[], type: string, body: Record<string, unknown>): Promise<void> => {
      await Promise.all(targets.filter((device) => device.takes(type)).map((device) => device.send(type, body).catch(() => undefined)));
    };

    // Polled, since a desktop clipboard has no change event a program outside it can follow.
    const timer = setInterval(async () => {
      if (watching || context.settings().send_automatically === false) return;
      watching = true;
      try {
        const now = await clipboard.read();
        if (now === null || now === content) return;
        content = now;
        changed_at = Date.now();
        await send_to(devices.all(), clipboard_type, { content });
      } finally {
        watching = false;
      }
    }, watch_interval_in_milliseconds);
    context.on_stop(() => clearInterval(timer));

    const take = async (text: string, at: number): Promise<void> => {
      if (context.settings().receive_automatically === false || text === content) return;
      content = text;
      changed_at = at;
      await clipboard.write(text);
    };

    context.provide("capability", "clipboard", {
      incoming: [clipboard_type, connect_type],
      outgoing: [clipboard_type, connect_type],
      connected(device) {
        devices.add(device);
        if (context.settings().send_automatically === false || !content) return;
        return send_to([device], connect_type, { content, timestamp: changed_at });
      },
      disconnected: devices.remove,
      async packet(_device, packet) {
        const text = text_field(packet.body, "content");
        if (packet.type === clipboard_type) return take(text, Date.now());
        // A connecting device's clipboard wins only when it is newer; a time of 0 means it does not know.
        const timestamp = number_field(packet.body, "timestamp");
        if (timestamp > 0 && timestamp > changed_at) await take(text, timestamp);
      },
      actions: {
        send: {
          label: "Send to clipboard",
          description: "Puts text on the device's clipboard.",
          params: [{ name: "text", schema: { type: "string", description: "The text to copy." } }],
          needs: clipboard_type,
          run: (device, args) => device.send(clipboard_type, { content: text_arg(args, "text") }),
        },
        push: {
          label: "Send this clipboard",
          description: "Sends what this computer's clipboard holds now to the device.",
          needs: clipboard_type,
          run: async (device) => device.send(clipboard_type, { content: (await clipboard.read()) ?? "" }),
        },
      },
    });
  },
});
