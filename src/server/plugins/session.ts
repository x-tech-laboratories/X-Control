// Session: whether the session is locked, with a switch to lock and unlock it, how long it has been idle, who is
// signed in, and whether the camera, microphone or speakers are in use, as LNXlink's session lock, idle, current user,
// camera used, microphone used and speaker used modules read them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { session_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi, Entity } from "./api.ts";
import { shared_reading } from "./helpers.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const session_plugin = define_plugin<ControlPluginApi>({
  ...session_manifest,
  start(context) {
    const { session, readings } = context.services.system;
    const in_use = shared_reading(() => readings.devices_in_use());
    context.provide("entities", "session", {
      list: (): Entity[] => [
        { id: "locked", name: "Locked", kind: "switch", icon: "mdi:lock", read: () => session.is_locked(), set: (locked) => (locked === true ? session.lock() : session.unlock()) },
        { id: "idle", name: "Idle for", kind: "sensor", icon: "mdi:timer-sand", unit: "s", device_class: "duration", read: () => readings.idle_seconds() },
        { id: "user", name: "User", kind: "sensor", icon: "mdi:account", category: "diagnostic", every: 300, read: () => readings.user() },
        { id: "camera", name: "Camera in use", kind: "binary_sensor", icon: "mdi:webcam", read: async () => (await in_use()).camera },
        { id: "microphone", name: "Microphone in use", kind: "binary_sensor", icon: "mdi:microphone", read: async () => (await in_use()).microphone },
        { id: "speakers", name: "Speakers in use", kind: "binary_sensor", icon: "mdi:speaker", read: async () => (await in_use()).speakers },
      ],
    });
  },
});
