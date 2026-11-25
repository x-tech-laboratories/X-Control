// Calls: a phone ringing, a call under way or missed, told here; the phone's ringing can be muted from the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { telephony_manifest } from "../../shared/plugins/manifests.ts";
import type { CallState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi } from "./api.ts";
import { text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const telephony_type = "kdeconnect.telephony";
const mute_type = "kdeconnect.telephony.request_mute";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const telephony_plugin = define_plugin<ControlPluginApi>({
  ...telephony_manifest,
  start(context) {
    context.provide("capability", "telephony", {
      incoming: [telephony_type],
      outgoing: [mute_type],
      packet(device, packet) {
        const event = text_field(packet.body, "event");
        const caller = text_field(packet.body, "contactName") || text_field(packet.body, "phoneNumber") || "Unknown caller";
        const key = `call:${device.id}`;
        if (packet.body.isCancel === true) {
          device.set_state({ call: null } satisfies CallState);
          return context.services.withdraw(key);
        }
        if (event === "ringing" || event === "talking") device.set_state({ call: { event, caller } } satisfies CallState);
        if (event === "ringing") context.services.notify({ kind: "call", key, title: `${caller} is calling`, body: `On ${device.name}.`, route: `#/devices/${device.id}`, urgency: "critical" });
        if (event === "missedCall") {
          device.set_state({ call: null } satisfies CallState);
          context.services.notify({ kind: "call", key, title: `Missed call from ${caller}`, body: `On ${device.name}.`, route: `#/devices/${device.id}` });
        }
      },
      actions: {
        mute: { label: "Mute ringing", description: "Silences the phone's ringtone for the call ringing now.", needs: mute_type, run: (device) => device.send(mute_type, {}) },
      },
    });
  },
});
