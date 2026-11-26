// KDE Connect over Bluetooth: X-Control's profile registered with BlueZ, every connection BlueZ hands over taken
// through the multiplexer and the handshake into a device link, and bonded devices that offer KDE Connect asked to
// connect every half minute while they are not reached otherwise, since Android only looks once when it starts.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Duplex } from "node:stream";

import type { DeviceIdentity } from "../identity.ts";
import type { DeviceLink } from "../link.ts";
import { service_uuid, type BluezBus } from "./bluez.ts";
import { bluetooth_handshake } from "./link.ts";
import { create_mux, type Mux } from "./mux.ts";
import { address_of } from "./bluez.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface BluetoothOptions {
  // Opens BlueZ; it throws when the system bus or BlueZ is not there.
  bus: () => Promise<BluezBus>;
  identity: () => DeviceIdentity;
  capabilities: () => { incoming: string[]; outgoing: string[] };
  trusted_certificate: (device_id: string) => string | null;
  is_connected: (device_id: string) => boolean;
  on_link: (link: DeviceLink) => void;
  interval_ms?: number;
  log?: (message: string) => void;
}

export interface BluetoothStatus {
  state: "off" | "waiting" | "on";
  // Why Bluetooth is waiting, such as another KDE Connect app holding the profile.
  error: string | null;
  connections: number;
}

export interface BluetoothBackend {
  start(): Promise<void>;
  // Asks every bonded device offering KDE Connect to connect now.
  connect_now(): Promise<void>;
  status(): BluetoothStatus;
  stop(): Promise<void>;
}

// ── Backend ──────────────────────────────────────────────────────────────────

export function create_bluetooth_backend(options: BluetoothOptions): BluetoothBackend {
  const log = options.log ?? (() => {});
  const interval_ms = options.interval_ms ?? 30_000;
  const muxes = new Map<string, Mux>();
  // Which KDE Connect device each Bluetooth device turned out to be.
  const device_ids = new Map<string, string>();
  let bus: BluezBus | null = null;
  let registered = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last_error: string | null = null;

  const note = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    // Said once, rather than every half minute.
    if (message !== last_error) log(`Bluetooth: ${message}`);
    last_error = message;
  };

  async function take(device_path: string, socket: Duplex): Promise<void> {
    const existing = muxes.get(device_path);
    // One connection a device, as every KDE Connect does; the newer one is dropped.
    if (existing && !existing.is_closed()) return void socket.destroy();
    const mux = create_mux(socket, log);
    muxes.set(device_path, mux);
    void mux.closed.then(() => (muxes.get(device_path) === mux ? muxes.delete(device_path) : undefined));
    try {
      const link = await bluetooth_handshake(mux, { identity: options.identity(), capabilities: options.capabilities(), trusted_certificate: options.trusted_certificate, address: address_of(device_path) });
      device_ids.set(device_path, link.identity.deviceId);
      options.on_link(link);
    } catch (error) {
      log(`Bluetooth: ${address_of(device_path)}: ${error instanceof Error ? error.message : String(error)}`);
      mux.close();
    }
  }

  async function round(): Promise<void> {
    if (stopped) return;
    try {
      bus ??= await options.bus();
      if (!registered) {
        await bus.register_profile({
          connection: (device_path, socket) => void take(device_path, socket),
          disconnection: (device_path) => muxes.get(device_path)?.close(),
          released: () => void (registered = false),
        });
        registered = true;
        last_error = null;
        log("Bluetooth: KDE Connect's profile is registered with BlueZ");
      }
      for (const device of await bus.devices()) {
        if (!device.paired || !device.uuids.map((uuid) => uuid.toLowerCase()).includes(service_uuid)) continue;
        if (muxes.get(device.path) && !muxes.get(device.path)!.is_closed()) continue;
        const known = device_ids.get(device.path);
        if (known && options.is_connected(known)) continue;
        await bus.connect_profile(device.path).catch((error: unknown) => {
          // BlueZ says so when a connection is already up or on its way.
          if (!/AlreadyConnected|InProgress/.test(String((error as Error)?.message ?? error))) log(`Bluetooth: could not reach ${device.name || device.address}: ${(error as Error)?.message ?? String(error)}`);
        });
      }
    } catch (error) {
      registered = false;
      note(error);
      await bus?.close().catch(() => {});
      bus = null;
    }
  }

  return {
    async start() {
      stopped = false;
      await round();
      timer = setInterval(() => void round(), interval_ms);
    },
    connect_now: () => round(),
    status: () => ({ state: stopped ? "off" : registered ? "on" : "waiting", error: registered ? null : last_error, connections: [...muxes.values()].filter((mux) => !mux.is_closed()).length }),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const mux of muxes.values()) mux.close();
      muxes.clear();
      await bus?.close().catch(() => {});
      bus = null;
      registered = false;
    },
  };
}
