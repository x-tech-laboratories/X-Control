// What X-Control lets its daemon's plugins reach: a capability for each feature, such as battery or clipboard, that
// takes and sends KDE Connect packets for a device, the actions the page and other programs can run through it, and
// the services of the computer the daemon runs on.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ParamSpec } from "@x-tech-laboratories/x-libs/api_spec";
import type { Plugin } from "@x-tech-laboratories/x-libs/plugins";

import type { DeviceView } from "../../shared/devices/model.ts";
import type { Notice } from "../../shared/notices.ts";
import type { Packet, PacketBody } from "../../shared/kdeconnect/packet.ts";
import type { IncomingPayload, OutgoingPayload } from "../kdeconnect/link.ts";
import type { SystemServices } from "../system/services.ts";

// ── Devices ──────────────────────────────────────────────────────────────────

// One device as one plugin sees it: its own state for that device, and packets to send it.
export interface DeviceHandle {
  id: string;
  name: string;
  type: string;
  is_connected(): boolean;
  is_paired(): boolean;
  // Whether the device says it takes this packet type.
  takes(type: string): boolean;
  send(type: string, body: PacketBody, payload?: OutgoingPayload): Promise<void>;
  state<State>(): State | undefined;
  // Replaces what the plugin knows of the device; the pages hear of it.
  set_state(state: unknown): void;
}

// One thing a plugin can do to a device, such as sending text to its clipboard.
export interface DeviceAction {
  label: string;
  description: string;
  params?: ParamSpec[];
  // The packet type the device must take for this to work.
  needs?: string;
  run(device: DeviceHandle, args: Record<string, unknown>): unknown;
}

export interface Capability {
  // The packet types the plugin handles and sends, announced to other devices.
  incoming: string[];
  outgoing: string[];
  // A paired device connected, or was just paired.
  connected?(device: DeviceHandle): void | Promise<void>;
  disconnected?(device: DeviceHandle): void;
  packet?(device: DeviceHandle, packet: Packet, payload: IncomingPayload | null): void | Promise<void>;
  actions?: Record<string, DeviceAction>;
}

// ── Services ─────────────────────────────────────────────────────────────────

export interface RunCommand {
  id: string;
  name: string;
  command: string;
}

export interface ControlServices {
  system: SystemServices;
  // Tells the user, through the desktop's notifications or the server's channels, if that kind is on.
  notify(notice: Notice): void;
  // Takes back a notice shown earlier, by its key.
  withdraw(key: string): void;
  // The folder files from other devices land in.
  downloads_folder(): string;
  // The folder a device's files are mounted under, one subfolder per device.
  mounts_folder(): string;
  devices(): DeviceView[];
  // The run commands this device offers, from the synced catalogue.
  commands(): RunCommand[];
  log(message: string): void;
}

export interface ControlPluginApi {
  hooks: {
    "device.connected": (device: DeviceView) => void;
    "device.disconnected": (device: DeviceView) => void;
    "device.paired": (device: DeviceView) => void;
    "device.unpaired": (device: DeviceView) => void;
    // The run commands catalogue changed, so devices can be told the new list.
    "commands.changed": () => void;
  };
  providers: { capability: Capability };
  services: ControlServices;
}

export type ControlPlugin = Plugin<ControlPluginApi>;
