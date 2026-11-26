// What the page and other programs see of the devices X-Control knows: this device, and every other one that is
// paired or can be reached now, with what each plugin knows of it, such as a phone's battery.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeviceType } from "../kdeconnect/packet.ts";

// ── Devices ──────────────────────────────────────────────────────────────────

// Unpaired, waiting for the other device to answer this one's request, waiting for the user to answer its request, or paired.
export type PairState = "unpaired" | "requested" | "incoming" | "paired";

export interface DeviceView {
  id: string;
  name: string;
  type: DeviceType;
  pair_state: PairState;
  is_connected: boolean;
  // The address it was last reached at, such as "192.168.1.20".
  address: string | null;
  // The packet types it takes and sends, which say what it can do.
  incoming: string[];
  outgoing: string[];
  // The code both screens show while pairing, so the user can see they pair the device they mean.
  verification_key: string | null;
  // The SHA-256 fingerprint of its certificate, once known.
  fingerprint: string | null;
  // When it was paired and last seen, as ISO 8601 timestamps.
  paired_at: string | null;
  last_seen: string | null;
  // What each plugin knows of it, by plugin id, such as { battery: { charge: 80, is_charging: true } }.
  plugins: Record<string, unknown>;
}

export interface ThisDevice {
  id: string;
  name: string;
  type: DeviceType;
  // The TCP port other devices connect to, 0 while the network is off.
  tcp_port: number;
  fingerprint: string;
  discovery: boolean;
  // KDE Connect over Bluetooth: off, waiting (with why, such as another KDE Connect app holding it) or on.
  bluetooth: { state: "off" | "waiting" | "on"; error: string | null };
}

// One thing a plugin can do to a device, such as ringing a phone.
export interface DeviceActionView {
  // "<plugin id>.<action>", such as "findmyphone.ring".
  id: string;
  plugin_id: string;
  label: string;
  description: string;
  // The packet type the other device must take for the action to work.
  needs?: string;
}

// ── Paired devices ───────────────────────────────────────────────────────────

// A device paired with this daemon, kept so it is known again, and refused if it shows another certificate.
export interface PairedDevice {
  id: string;
  name: string;
  type: string;
  certificate: string;
  paired_at: string;
  last_address: string | null;
  last_seen: string | null;
}

export interface PairedStore {
  list(): PairedDevice[];
  get(id: string): PairedDevice | null;
  save(device: PairedDevice): void;
  // Removes the device and every state kept for it.
  remove(id: string): void;
  // What plugins kept of a device while it is away, by plugin id.
  states(id: string): Record<string, unknown>;
  save_state(id: string, plugin_id: string, state: unknown): void;
}
