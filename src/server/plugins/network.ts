// Network: each network card's download and upload speed, this computer's address and its Wi-Fi signal, as LNXlink's
// network, interfaces and wifi modules read them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import { network_manifest } from "../../shared/plugins/manifests.ts";
import type { NetworkInterface } from "../system/services.ts";
import type { ControlPluginApi, Entity } from "./api.ts";
import { rate_tracker, shared_reading } from "./helpers.ts";

// ── Interfaces ───────────────────────────────────────────────────────────────

// Cards that containers, virtual machines and VPN bridges make.
export function is_virtual(name: string): boolean {
  return /^(docker|veth|br-|virbr|vnet|lxc|lxd|podman|cni|flannel|cali|kube|tap)/.test(name);
}

// The address other computers on the network reach this one at: the first IPv4 address of a card that is up.
export function main_address(interfaces: NetworkInterface[]): string | null {
  for (const card of interfaces) {
    if (!card.is_up || is_virtual(card.name)) continue;
    const ipv4 = card.addresses.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address));
    if (ipv4) return ipv4;
  }
  return null;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const network_plugin = define_plugin<ControlPluginApi>({
  ...network_manifest,
  start(context) {
    const { readings } = context.services.system;
    const interfaces = shared_reading(() => readings.interfaces());
    const rate = rate_tracker();
    const kib = (value: number | null): number | null => (value === null ? null : Math.round(value / 102.4) / 10);
    const card_rate = async (name: string, key: "received_bytes" | "sent_bytes"): Promise<number | null> => {
      const card = (await interfaces()).find((entry) => entry.name === name);
      if (!card) throw new Error(`${name} is gone`);
      return kib(rate(`${name}.${key}`, card[key]));
    };
    context.provide("entities", "network", {
      async list() {
        const shown = (await interfaces()).filter((card) => card.is_up && (context.settings().virtual_interfaces === true || !is_virtual(card.name)));
        const entities: Entity[] = [
          {
            id: "address",
            name: "IP address",
            kind: "sensor",
            icon: "mdi:ip-network",
            category: "diagnostic",
            read: async () => {
              const read = await interfaces();
              return { value: main_address(read), attributes: Object.fromEntries(read.filter((card) => card.addresses.length > 0).map((card) => [card.name, card.addresses])) };
            },
          },
        ];
        for (const card of shown) {
          entities.push(
            { id: `${slug(card.name)}_download`, name: `${card.name} download`, kind: "sensor", icon: "mdi:download-network", unit: "kB/s", device_class: "data_rate", read: () => card_rate(card.name, "received_bytes") },
            { id: `${slug(card.name)}_upload`, name: `${card.name} upload`, kind: "sensor", icon: "mdi:upload-network", unit: "kB/s", device_class: "data_rate", read: () => card_rate(card.name, "sent_bytes") },
          );
        }
        const wifi = await readings.wifi().catch(() => null);
        if (wifi) {
          entities.push({
            id: "wifi_signal",
            name: "Wi-Fi signal",
            kind: "sensor",
            icon: "mdi:wifi",
            unit: "dBm",
            device_class: "signal_strength",
            read: async () => {
              const read = await readings.wifi();
              return { value: read?.signal_dbm ?? null, attributes: { network: read?.network ?? null, interface: read?.interface ?? null } };
            },
          });
        }
        return entities;
      },
    });
  },
});
