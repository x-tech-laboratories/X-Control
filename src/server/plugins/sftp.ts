// Browse files: a phone serves its storage over SFTP with a password made for this time only; this computer mounts
// it and opens it in the file manager. The password is used once and never kept or shown.

// ── Imports ──────────────────────────────────────────────────────────────────

import { join } from "node:path";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { sftp_manifest } from "../../shared/plugins/manifests.ts";
import type { SftpState } from "../../shared/plugins/states.ts";
import type { SftpShare } from "../system/services.ts";
import type { ControlPluginApi, DeviceHandle } from "./api.ts";
import { number_field, text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const sftp_type = "kdeconnect.sftp";
const request_type = "kdeconnect.sftp.request";

// The share a phone offers, or null when its packet lacks what a mount needs.
export function read_share(body: Record<string, unknown>, fallback_host: string): SftpShare | null {
  const port = number_field(body, "port");
  const user = text_field(body, "user");
  const password = text_field(body, "password");
  if (!port || !user || !password) return null;
  return { host: text_field(body, "ip") || fallback_host, port, user, password, path: text_field(body, "path") || "/" };
}

// The storage places a phone lists beside the share, each under the mount's own folder.
export function read_places(body: Record<string, unknown>, root: string, folder: string): SftpState["places"] {
  const paths = Array.isArray(body.multiPaths) ? body.multiPaths : [];
  const names = Array.isArray(body.pathNames) ? body.pathNames : [];
  return paths.flatMap((path, index) => {
    if (typeof path !== "string") return [];
    const relative = path.startsWith(root) ? path.slice(root.length) : path;
    return [{ name: typeof names[index] === "string" ? names[index] : path, path: join(folder, relative) }];
  });
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const sftp_plugin = define_plugin<ControlPluginApi>({
  ...sftp_manifest,
  start(context) {
    const { system } = context.services;
    const mounted = new Map<string, string>();
    const folder_for = (device: DeviceHandle): string => join(context.services.mounts_folder(), device.id);

    const unmount = async (device: DeviceHandle): Promise<void> => {
      const folder = mounted.get(device.id);
      if (!folder) return;
      mounted.delete(device.id);
      await system.files.unmount(folder).catch((error: unknown) => context.services.log(`could not unmount ${folder}: ${(error as Error).message}`));
      device.set_state({ folder: null, places: [], error: null } satisfies SftpState);
    };

    // Mounts go when the plugin stops, so no folder is left hanging on a phone that is gone.
    context.on_stop(async () => {
      for (const folder of mounted.values()) await system.files.unmount(folder).catch(() => undefined);
      mounted.clear();
    });

    context.provide("capability", "sftp", {
      incoming: [sftp_type],
      outgoing: [request_type],
      disconnected: (device) => void unmount(device),
      async packet(device, packet) {
        const error = text_field(packet.body, "errorMessage");
        if (error) return device.set_state({ folder: null, places: [], error } satisfies SftpState);
        const devices = context.services.devices();
        const address = devices.find((candidate) => candidate.id === device.id)?.address ?? "";
        const share = read_share(packet.body, address);
        if (!share) return device.set_state({ folder: null, places: [], error: "The phone sent no way to reach its files." } satisfies SftpState);
        const folder = folder_for(device);
        if (mounted.has(device.id)) await unmount(device);
        try {
          await system.files.mount(share, folder);
        } catch (failure) {
          return device.set_state({ folder: null, places: [], error: (failure as Error).message } satisfies SftpState);
        }
        mounted.set(device.id, folder);
        const places = read_places(packet.body, share.path, folder);
        device.set_state({ folder, places, error: null } satisfies SftpState);
        await system.open(places[0]?.path ?? folder).catch(() => undefined);
      },
      actions: {
        browse: { label: "Browse files", description: "Mounts the phone's storage on this computer and opens it in the file manager.", needs: request_type, run: (device) => device.send(request_type, { startBrowsing: true }) },
        unmount: { label: "Stop browsing", description: "Unmounts the phone's storage from this computer.", run: (device) => unmount(device) },
      },
    });
  },
});
