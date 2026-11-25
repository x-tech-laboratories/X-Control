// KDE Connect over mDNS: this device advertised as a `_kdeconnect._udp` service named by its id, and every such
// service found told who this device is over UDP, so it connects as it would after a broadcast. Phones on networks
// that drop broadcasts still find each other this way.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Bonjour, type Service } from "bonjour-service";

import { discovery_port, protocol_version } from "../../shared/kdeconnect/packet.ts";
import type { DeviceIdentity } from "./identity.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface MdnsOptions {
  identity: () => DeviceIdentity;
  // Tells the device at an address who this one is.
  announce: (address: string) => void;
  on_warning?: (message: string) => void;
}

export interface MdnsDiscovery {
  stop(): Promise<void>;
}

const service_type = "kdeconnect";

// The addresses to tell of a service found, or none when it is this device's own or no KDE Connect device.
export function addresses_to_tell(service: Pick<Service, "name" | "txt" | "addresses" | "referer">, own_id: string): string[] {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const id = typeof txt.id === "string" ? txt.id : service.name;
  if (!id || id === own_id) return [];
  const addresses = (service.addresses ?? []).filter((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address));
  if (addresses.length === 0 && service.referer?.family === "IPv4") addresses.push(service.referer.address);
  return [...new Set(addresses)];
}

// ── Discovery ────────────────────────────────────────────────────────────────

export function start_mdns(options: MdnsOptions): MdnsDiscovery {
  const identity = options.identity();
  const bonjour = new Bonjour({}, (error: Error) => options.on_warning?.(`mDNS: ${error.message}`));
  bonjour.publish({
    name: identity.device_id,
    type: service_type,
    protocol: "udp",
    port: discovery_port,
    txt: { id: identity.device_id, name: identity.name, type: identity.type, protocol: String(protocol_version) },
    disableIPv6: true,
  });
  const browser = bonjour.find({ type: service_type, protocol: "udp" }, (service) => {
    for (const address of addresses_to_tell(service, options.identity().device_id)) options.announce(address);
  });
  return {
    stop: () =>
      new Promise((resolve) => {
        browser.stop();
        bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
      }),
  };
}
