// BlueZ on the system bus, as KDE Connect over Bluetooth needs it: a Profile1 for KDE Connect's service UUID, which
// BlueZ advertises over SDP and through which it hands over every RFCOMM connection, made by either side, as a file
// descriptor; the bonded devices offering the service; and asking BlueZ to connect to one.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createReadStream, createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { Duplex } from "node:stream";

// ── Constants ────────────────────────────────────────────────────────────────

export const service_uuid = "185f3df4-3268-4e3f-9fca-d4d5059915bd";
export const profile_path = "/org/xtech/XControl/bluez";

// ── Bus ──────────────────────────────────────────────────────────────────────

export interface BluezDevice {
  // Its object path, such as "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF".
  path: string;
  address: string;
  name: string;
  paired: boolean;
  uuids: string[];
}

export interface ProfileHandlers {
  connection(device_path: string, socket: Duplex): void;
  disconnection(device_path: string): void;
  released(): void;
}

// What the Bluetooth backend asks of BlueZ; tests hand in a BlueZ of their own.
export interface BluezBus {
  register_profile(handlers: ProfileHandlers): Promise<void>;
  devices(): Promise<BluezDevice[]>;
  connect_profile(device_path: string): Promise<void>;
  close(): Promise<void>;
}

// A device's address from its object path, as BlueZ writes it with underscores.
export function address_of(device_path: string): string {
  return /dev_([0-9A-Fa-f_]{17})$/.exec(device_path)?.[1]?.replace(/_/g, ":") ?? device_path;
}

// ── Sockets ──────────────────────────────────────────────────────────────────

// An RFCOMM socket's descriptor as a stream. libuv's pipe handle takes any stream socket, though Node only offers
// it through the old process.binding; without it the descriptor is read and written as a file.
export function socket_from_fd(fd: number): Duplex {
  try {
    const binding = (process as unknown as { binding(name: string): { Pipe: new (type: number) => { open(fd: number): number }; constants: { SOCKET: number } } }).binding("pipe_wrap");
    const handle = new binding.Pipe(binding.constants.SOCKET);
    if (handle.open(fd) === 0) return new Socket({ handle, readable: true, writable: true } as never);
  } catch {
    // Falls through to reading and writing the descriptor as a file.
  }
  return Duplex.from({ readable: createReadStream("", { fd, autoClose: true }), writable: createWriteStream("", { fd, autoClose: false }) });
}

// ── dbus-next ────────────────────────────────────────────────────────────────

type DbusNext = typeof import("dbus-next");

// Whether descriptors can come over D-Bus: dbus-next needs the native usocket module for them.
export function unix_fd_support(): { ok: true } | { ok: false; reason: string } {
  try {
    createRequire(import.meta.url)("usocket");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `the usocket module did not load (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
  }
}

// BlueZ through dbus-next on the system bus, with descriptors passed.
export async function system_bluez(): Promise<BluezBus> {
  const dbus = createRequire(import.meta.url)("dbus-next") as DbusNext;
  const bus = dbus.systemBus({ negotiateUnixFd: true } as never);
  let exported: InstanceType<DbusNext["interface"]["Interface"]> | null = null;

  const bluez_root = await bus.getProxyObject("org.bluez", "/");
  const objects = bluez_root.getInterface("org.freedesktop.DBus.ObjectManager");

  return {
    async register_profile(handlers) {
      if (!exported) {
        class Profile extends dbus.interface.Interface {
          Release(): void {
            handlers.released();
          }
          NewConnection(device: string, fd: number): void {
            handlers.connection(device, socket_from_fd(fd));
          }
          RequestDisconnection(device: string): void {
            handlers.disconnection(device);
          }
        }
        Profile.configureMembers({
          methods: {
            Release: { inSignature: "", outSignature: "" },
            NewConnection: { inSignature: "oha{sv}", outSignature: "" },
            RequestDisconnection: { inSignature: "o", outSignature: "" },
          },
        });
        exported = new Profile("org.bluez.Profile1");
        bus.export(profile_path, exported);
      }
      const manager = (await bus.getProxyObject("org.bluez", "/org/bluez")).getInterface("org.bluez.ProfileManager1");
      const options = {
        Name: new dbus.Variant("s", "KDE Connect"),
        Service: new dbus.Variant("s", service_uuid),
        RequireAuthentication: new dbus.Variant("b", true),
        RequireAuthorization: new dbus.Variant("b", false),
      };
      await manager.RegisterProfile!(profile_path, service_uuid, options);
    },
    async devices() {
      const managed = (await objects.GetManagedObjects!()) as Record<string, Record<string, Record<string, { value: unknown }>>>;
      return Object.entries(managed).flatMap(([path, interfaces]) => {
        const device = interfaces["org.bluez.Device1"];
        if (!device) return [];
        return [{ path, address: String(device.Address?.value ?? address_of(path)), name: String(device.Name?.value ?? device.Alias?.value ?? ""), paired: device.Paired?.value === true, uuids: Array.isArray(device.UUIDs?.value) ? (device.UUIDs.value as string[]) : [] }];
      });
    },
    async connect_profile(device_path) {
      const device = (await bus.getProxyObject("org.bluez", device_path)).getInterface("org.bluez.Device1");
      await device.ConnectProfile!(service_uuid);
    },
    async close() {
      if (exported) bus.unexport(profile_path, exported);
      bus.disconnect();
    },
  };
}
