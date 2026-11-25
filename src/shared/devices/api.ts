// The calls on the devices a daemon reaches, answered by its KDE Connect side rather than its database: listing and
// pairing devices, and running what their plugins offer, such as ringing a phone.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { id_of, text } from "../api_schemas.ts";
import type { DeviceActionView, DeviceView, ThisDevice } from "./model.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export interface DeviceMethods {
  get_this_device(): Promise<ThisDevice>;
  rename_this_device(name: string): Promise<void>;
  list_devices(): Promise<DeviceView[]>;
  get_device(id: string): Promise<DeviceView>;
  list_device_actions(id: string): Promise<DeviceActionView[]>;
  run_device_action(id: string, action: string, args: Record<string, unknown>): Promise<unknown>;
  pair_device(id: string): Promise<void>;
  accept_pairing(id: string): Promise<void>;
  reject_pairing(id: string): Promise<void>;
  unpair_device(id: string): Promise<void>;
  refresh_devices(): Promise<void>;
  connect_address(address: string): Promise<void>;
}

export const device_method_names = [
  "get_this_device",
  "rename_this_device",
  "list_devices",
  "get_device",
  "list_device_actions",
  "run_device_action",
  "pair_device",
  "accept_pairing",
  "reject_pairing",
  "unpair_device",
  "refresh_devices",
  "connect_address",
] as const satisfies readonly (keyof DeviceMethods)[];

const device_id = { name: "id", schema: id_of("device") };

export const device_api: ApiSpec<DeviceMethods> = {
  get_this_device: { description: "The device this daemon runs on as other devices see it: its KDE Connect id, name, type, TCP port and certificate fingerprint.", params: [] },
  rename_this_device: { description: "Changes the name other devices show for this one; 1 to 32 characters, without punctuation such as quotes or dots.", params: [{ name: "name", schema: text("The new name.") }] },
  list_devices: {
    description:
      "Every device this daemon knows: the paired ones and any other connected now. Each has its pair_state (unpaired, requested, incoming or paired), whether it is connected, the packet types it takes and sends, and what each plugin knows of it under plugins, such as battery.charge.",
    params: [],
  },
  get_device: { description: "One device, as list_devices gives it.", params: [device_id] },
  list_device_actions: { description: "What can be done to a device through its plugins, such as findmyphone.ring or share.url, each with its label and description.", params: [device_id] },
  run_device_action: {
    description:
      "Runs one of a paired device's actions by id, such as ping.send, findmyphone.ring, clipboard.send ({ text }), share.url ({ url }), share.text ({ text }), share.file ({ path }), notification.dismiss ({ id }), notification.reply ({ reply_id, message }), runcommand.run ({ key }), mpris.act ({ player, action }), systemvolume.volume ({ sink, volume }) or lock.lock.",
    params: [device_id, { name: "action", schema: text("The action's id, from list_device_actions.") }, { name: "args", schema: { type: "object", description: "The action's arguments by name; {} for none." } }],
  },
  pair_device: { description: "Asks a connected device to pair; its user must accept within 30 seconds, after checking both screens show the same verification key.", params: [device_id] },
  accept_pairing: { description: "Accepts a device's request to pair.", params: [device_id] },
  reject_pairing: { description: "Turns down a device's request to pair, or takes back this one's.", params: [device_id] },
  unpair_device: { description: "Unpairs a device, on both sides when it is connected; it must be paired again to do anything.", params: [device_id], destructive: true },
  refresh_devices: { description: "Says who this device is to the network again, so devices nearby connect.", params: [] },
  connect_address: { description: "Reaches a device at an address directly, for networks where devices cannot find each other, such as across a VPN.", params: [{ name: "address", schema: text("Its IP address or host name, such as 192.168.1.20.") }] },
};
