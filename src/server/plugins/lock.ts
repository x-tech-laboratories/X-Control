// Lock: a device can lock and unlock this computer's session, and this computer can lock a device that allows it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { lock_manifest } from "../../shared/plugins/manifests.ts";
import type { LockState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi, DeviceHandle } from "./api.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const lock_type = "kdeconnect.lock";
const request_type = "kdeconnect.lock.request";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const lock_plugin = define_plugin<ControlPluginApi>({
  ...lock_manifest,
  start(context) {
    const { session } = context.services.system;
    const send_own = async (device: DeviceHandle): Promise<void> => {
      if (device.takes(lock_type)) await device.send(lock_type, { isLocked: await session.is_locked() });
    };

    context.provide("capability", "lock", {
      incoming: [lock_type, request_type],
      outgoing: [lock_type, request_type],
      connected: (device) => (device.takes(request_type) ? device.send(request_type, { requestLocked: true }) : undefined),
      async packet(device, packet) {
        if (packet.type === lock_type) return device.set_state({ is_locked: packet.body.isLocked === true } satisfies LockState);
        if (typeof packet.body.setLocked === "boolean") {
          context.services.log(`${device.name} ${packet.body.setLocked ? "locks" : "unlocks"} this computer`);
          await (packet.body.setLocked ? session.lock() : session.unlock());
        }
        await send_own(device);
      },
      actions: {
        lock: { label: "Lock", description: "Locks the device's screen.", needs: request_type, run: (device) => device.send(request_type, { setLocked: true }) },
        unlock: { label: "Unlock", description: "Unlocks the device's screen, where it allows that.", needs: request_type, run: (device) => device.send(request_type, { setLocked: false }) },
      },
    });
  },
});
