// Calls: a phone ringing, a call under way or missed, told here; the phone's ringing can be muted from the page, and
// this computer's speakers and players are quieted while a call rings or is under way.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { telephony_manifest } from "../../shared/plugins/manifests.ts";
import type { CallState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi } from "./api.ts";
import { create_call_quiet, type SpeakerChoice } from "./call_quiet.ts";
import { text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const telephony_type = "kdeconnect.telephony";
const mute_type = "kdeconnect.telephony.request_mute";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const telephony_plugin = define_plugin<ControlPluginApi>({
  ...telephony_manifest,
  start(context) {
    const quiet = create_call_quiet(context.services.system);
    // Devices with a call ringing or under way; the computer stays quiet until none has.
    const calling = new Set<string>();
    const speakers = (key: string): SpeakerChoice => {
      const value = context.settings()[key];
      return value === "nothing" || value === "mute" ? value : "lower";
    };
    const quiet_for = async (device_id: string, event: "ringing" | "talking"): Promise<void> => {
      calling.add(device_id);
      const settings = context.settings();
      await quiet.apply(event === "ringing" ? { speakers: speakers("ringing_speakers"), pause: settings.ringing_pause === true } : { speakers: speakers("talking_speakers"), pause: settings.talking_pause !== false });
    };
    const call_over = async (device_id: string): Promise<void> => {
      if (!calling.delete(device_id) || calling.size > 0) return;
      await quiet.restore();
    };
    context.on_stop(() => quiet.restore());

    context.provide("capability", "telephony", {
      incoming: [telephony_type],
      outgoing: [mute_type],
      disconnected: (device) => void call_over(device.id),
      async packet(device, packet) {
        const event = text_field(packet.body, "event");
        const caller = text_field(packet.body, "contactName") || text_field(packet.body, "phoneNumber") || "Unknown caller";
        const key = `call:${device.id}`;
        if (packet.body.isCancel === true) {
          device.set_state({ call: null } satisfies CallState);
          context.services.withdraw(key);
          return call_over(device.id);
        }
        if (event === "ringing" || event === "talking") device.set_state({ call: { event, caller } } satisfies CallState);
        if (event === "ringing") context.services.notify({ kind: "call", key, title: `${caller} is calling`, body: `On ${device.name}.`, route: `#/devices/${device.id}`, urgency: "critical" });
        if (event === "missedCall") {
          device.set_state({ call: null } satisfies CallState);
          context.services.notify({ kind: "call", key, title: `Missed call from ${caller}`, body: `On ${device.name}.`, route: `#/devices/${device.id}` });
          return call_over(device.id);
        }
        if (event === "ringing" || event === "talking") await quiet_for(device.id, event);
      },
      actions: {
        mute: { label: "Mute ringing", description: "Silences the phone's ringtone for the call ringing now.", needs: mute_type, run: (device) => device.send(mute_type, {}) },
      },
    });
  },
});
