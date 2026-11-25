// Every device X-Control knows: the paired ones kept in the store, and any other that has connected. It pairs and
// unpairs them as KDE Connect does, and hands a paired device's packets to the plugins whose capability takes them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { make_packet, pair_type, type IdentityBody, type Packet, type PacketBody } from "../../shared/kdeconnect/packet.ts";
import type { DeviceActionView, DeviceView, PairedStore, PairState } from "../../shared/devices/model.ts";
import type { Notice } from "../../shared/notices.ts";
import type { Capability, DeviceHandle } from "../plugins/api.ts";
import { fingerprint_of, verification_key, type DeviceIdentity } from "./identity.ts";
import type { DeviceLink, IncomingPayload, OutgoingPayload } from "./link.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface PluginCapability {
  plugin_id: string;
  capability: Capability;
}

export interface DeviceManagerOptions {
  identity: () => DeviceIdentity;
  paired: PairedStore;
  // The running plugins' capabilities, read afresh each time, since plugins start and stop.
  capabilities: () => PluginCapability[];
  notify: (notice: Notice) => void;
  withdraw: (key: string) => void;
  // A device came, went or changed; the pages fetch again.
  on_change: () => void;
  on_event?: (event: "device.connected" | "device.disconnected" | "device.paired" | "device.unpaired", device: DeviceView) => void;
  log?: (message: string) => void;
  now?: () => number;
}

interface Entry {
  id: string;
  identity: IdentityBody | null;
  link: DeviceLink | null;
  pair_state: PairState;
  // The time, in seconds, of the pairing request under way, which goes into the verification key.
  pair_timestamp: number | null;
  pair_timer: ReturnType<typeof setTimeout> | undefined;
  states: Map<string, unknown>;
}

// A request not answered by then is dropped, as every KDE Connect device does.
export const pair_timeout_in_milliseconds = 30_000;
// A request whose clock is further off than this is refused.
const most_clock_difference_in_seconds = 30 * 60;

// ── Manager ──────────────────────────────────────────────────────────────────

export type DeviceManager = ReturnType<typeof create_device_manager>;

export function create_device_manager(options: DeviceManagerOptions) {
  const entries = new Map<string, Entry>();
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  function entry_of(id: string): Entry {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, identity: null, link: null, pair_state: options.paired.get(id) ? "paired" : "unpaired", pair_timestamp: null, pair_timer: undefined, states: new Map() };
      entries.set(id, entry);
    }
    return entry;
  }

  function require_entry(id: string): Entry {
    const entry = entries.get(id) ?? (options.paired.get(id) ? entry_of(id) : undefined);
    if (!entry) throw new Error(`No device with the id ${id}.`);
    return entry;
  }

  function view(entry: Entry): DeviceView {
    const paired = options.paired.get(entry.id);
    const certificate = entry.link?.certificate ?? paired?.certificate ?? null;
    const key = entry.link && entry.pair_timestamp !== null ? verification_key(options.identity().certificate, entry.link.certificate, entry.pair_timestamp) : null;
    return {
      id: entry.id,
      name: entry.identity?.deviceName ?? paired?.name ?? "Unknown device",
      type: (entry.identity?.deviceType ?? paired?.type ?? "desktop") as DeviceView["type"],
      pair_state: entry.pair_state,
      is_connected: entry.link?.is_open() ?? false,
      address: entry.link?.address ?? paired?.last_address ?? null,
      incoming: entry.identity?.incomingCapabilities ?? [],
      outgoing: entry.identity?.outgoingCapabilities ?? [],
      verification_key: entry.pair_state === "requested" || entry.pair_state === "incoming" ? key : null,
      fingerprint: certificate ? fingerprint_of(certificate) : null,
      paired_at: paired?.paired_at ?? null,
      last_seen: entry.link?.is_open() ? new Date(now()).toISOString() : (paired?.last_seen ?? null),
      plugins: Object.fromEntries(entry.states),
    };
  }

  function changed(): void {
    options.on_change();
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  async function send(entry: Entry, type: string, body: PacketBody, payload?: OutgoingPayload): Promise<void> {
    if (!entry.link?.is_open()) throw new Error(`${view(entry).name} is not connected.`);
    await entry.link.send(make_packet(type, body), payload);
  }

  function handle(entry: Entry, plugin_id: string): DeviceHandle {
    return {
      id: entry.id,
      name: view(entry).name,
      type: view(entry).type,
      is_connected: () => entry.link?.is_open() ?? false,
      is_paired: () => entry.pair_state === "paired",
      takes: (type) => entry.identity?.incomingCapabilities.includes(type) ?? false,
      send: (type, body, payload) => {
        if (entry.pair_state !== "paired") return Promise.reject(new Error(`${view(entry).name} is not paired.`));
        return send(entry, type, body, payload);
      },
      state: <State>() => entry.states.get(plugin_id) as State | undefined,
      set_state: (state) => {
        entry.states.set(plugin_id, state);
        changed();
      },
    };
  }

  // Runs one step of every running capability, keeping one plugin's failure from stopping the others.
  function each_capability(entry: Entry, step: (capability: Capability, device: DeviceHandle) => unknown): void {
    for (const { plugin_id, capability } of options.capabilities()) {
      try {
        const result = step(capability, handle(entry, plugin_id));
        if (result instanceof Promise) result.catch((error: unknown) => log(`${plugin_id}: ${(error as Error).message}`));
      } catch (error) {
        log(`${plugin_id}: ${(error as Error).message}`);
      }
    }
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  function set_pair_state(entry: Entry, state: PairState): void {
    clearTimeout(entry.pair_timer);
    entry.pair_timer = undefined;
    entry.pair_state = state;
    if (state !== "requested" && state !== "incoming") entry.pair_timestamp = null;
    if (state === "requested" || state === "incoming") {
      entry.pair_timer = setTimeout(() => {
        entry.pair_state = "unpaired";
        entry.pair_timestamp = null;
        options.withdraw(`pair:${entry.id}`);
        changed();
      }, pair_timeout_in_milliseconds);
    }
    if (state !== "incoming") options.withdraw(`pair:${entry.id}`);
    changed();
  }

  function become_paired(entry: Entry): void {
    if (!entry.link) return;
    const iso = new Date(now()).toISOString();
    options.paired.save({ id: entry.id, name: view(entry).name, type: view(entry).type, certificate: entry.link.certificate, paired_at: iso, last_address: entry.link.address, last_seen: iso });
    set_pair_state(entry, "paired");
    options.on_event?.("device.paired", view(entry));
    each_capability(entry, (capability, device) => capability.connected?.(device));
  }

  function become_unpaired(entry: Entry): void {
    const was_paired = entry.pair_state === "paired";
    options.paired.remove(entry.id);
    entry.states.clear();
    set_pair_state(entry, "unpaired");
    if (was_paired) options.on_event?.("device.unpaired", view(entry));
  }

  function on_pair_packet(entry: Entry, body: PacketBody): void {
    if (body.pair !== true) {
      if (entry.pair_state !== "unpaired") become_unpaired(entry);
      return;
    }
    if (entry.pair_state === "requested") return become_paired(entry);
    // A paired device asking again lost its pairing, and is answered at once.
    if (entry.pair_state === "paired") return void send(entry, pair_type, { pair: true }).catch(() => undefined);
    const timestamp = typeof body.timestamp === "number" ? body.timestamp : null;
    if (timestamp === null || Math.abs(now() / 1000 - timestamp) > most_clock_difference_in_seconds) {
      log(`${view(entry).name} asked to pair with a clock too far off; refused`);
      return void send(entry, pair_type, { pair: false }).catch(() => undefined);
    }
    entry.pair_timestamp = timestamp;
    set_pair_state(entry, "incoming");
    const device = view(entry);
    options.notify({ kind: "pair_request", key: `pair:${entry.id}`, title: `${device.name} wants to pair`, body: `Check both screens show ${device.verification_key}, then accept in X-Control.`, route: `#/devices/${entry.id}`, urgency: "critical" });
  }

  // ── Packets ──────────────────────────────────────────────────────────────

  function on_packet(entry: Entry, packet: Packet, payload: IncomingPayload | null): void {
    if (packet.type === pair_type) return on_pair_packet(entry, packet.body);
    // An unpaired device may only ask to pair.
    if (entry.pair_state !== "paired") return;
    each_capability(entry, (capability, device) => (capability.incoming.includes(packet.type) ? capability.packet?.(device, packet, payload) : undefined));
  }

  function attach(link: DeviceLink): void {
    const entry = entry_of(link.identity.deviceId);
    if (entry.link && entry.link !== link) entry.link.close();
    entry.link = link;
    entry.identity = link.identity;
    link.set_handlers({
      on_packet: (packet, payload) => on_packet(entry, packet, payload),
      on_close: () => {
        if (entry.link !== link) return;
        entry.link = null;
        if (entry.pair_state === "requested" || entry.pair_state === "incoming") set_pair_state(entry, "unpaired");
        if (entry.pair_state === "paired") {
          const paired = options.paired.get(entry.id);
          if (paired) options.paired.save({ ...paired, last_seen: new Date(now()).toISOString() });
          each_capability(entry, (capability, device) => capability.disconnected?.(device));
        } else entries.delete(entry.id);
        options.on_event?.("device.disconnected", view(entry));
        changed();
      },
    });
    const paired = options.paired.get(entry.id);
    if (paired) {
      options.paired.save({ ...paired, name: link.identity.deviceName, type: link.identity.deviceType, last_address: link.address, last_seen: new Date(now()).toISOString() });
      entry.pair_state = "paired";
    }
    log(`${link.identity.deviceName} connected from ${link.address}`);
    options.on_event?.("device.connected", view(entry));
    if (paired) each_capability(entry, (capability, device) => capability.connected?.(device));
    changed();
  }

  // ── Calls ────────────────────────────────────────────────────────────────

  function list(): DeviceView[] {
    for (const paired of options.paired.list()) entry_of(paired.id);
    return [...entries.values()].map(view).sort((first, second) => Number(second.pair_state === "paired") - Number(first.pair_state === "paired") || first.name.localeCompare(second.name));
  }

  function actions(id: string): DeviceActionView[] {
    const entry = require_entry(id);
    return options.capabilities().flatMap(({ plugin_id, capability }) =>
      Object.entries(capability.actions ?? {})
        .filter(([, action]) => !action.needs || (entry.identity?.incomingCapabilities.includes(action.needs) ?? true))
        .map(([name, action]) => ({ id: `${plugin_id}.${name}`, plugin_id, label: action.label, description: action.description, needs: action.needs })),
    );
  }

  async function run_action(id: string, action_id: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = require_entry(id);
    const dot = action_id.indexOf(".");
    const plugin_id = action_id.slice(0, dot);
    const name = action_id.slice(dot + 1);
    const found = options.capabilities().find((candidate) => candidate.plugin_id === plugin_id);
    const action = found?.capability.actions?.[name];
    if (!found || !action) throw new Error(`No action ${action_id}; the plugin may be off.`);
    if (entry.pair_state !== "paired") throw new Error(`${view(entry).name} is not paired.`);
    return await action.run(handle(entry, plugin_id), args);
  }

  return {
    attach,
    list,
    get: (id: string): DeviceView => view(require_entry(id)),
    handle: (id: string, plugin_id: string): DeviceHandle => handle(require_entry(id), plugin_id),
    actions,
    run_action,
    is_connected: (id: string): boolean => entries.get(id)?.link?.is_open() ?? false,
    trusted_certificate: (id: string): string | null => options.paired.get(id)?.certificate ?? null,
    // The packet types every running plugin takes and sends, as this device announces them.
    capabilities(): { incoming: string[]; outgoing: string[] } {
      const all = options.capabilities().map((entry) => entry.capability);
      return { incoming: [...new Set(all.flatMap((capability) => capability.incoming))].sort(), outgoing: [...new Set(all.flatMap((capability) => capability.outgoing))].sort() };
    },
    async request_pair(id: string): Promise<void> {
      const entry = require_entry(id);
      if (entry.pair_state === "paired") return;
      if (entry.pair_state === "incoming") return become_paired((await send(entry, pair_type, { pair: true }), entry));
      entry.pair_timestamp = Math.floor(now() / 1000);
      await send(entry, pair_type, { pair: true, timestamp: entry.pair_timestamp });
      set_pair_state(entry, "requested");
    },
    async accept_pair(id: string): Promise<void> {
      const entry = require_entry(id);
      if (entry.pair_state !== "incoming") throw new Error(`${view(entry).name} has not asked to pair.`);
      await send(entry, pair_type, { pair: true });
      become_paired(entry);
    },
    async reject_pair(id: string): Promise<void> {
      const entry = require_entry(id);
      if (entry.pair_state !== "incoming" && entry.pair_state !== "requested") return;
      await send(entry, pair_type, { pair: false }).catch(() => undefined);
      set_pair_state(entry, "unpaired");
    },
    async unpair(id: string): Promise<void> {
      const entry = require_entry(id);
      if (entry.link?.is_open()) await send(entry, pair_type, { pair: false }).catch(() => undefined);
      become_unpaired(entry);
      if (!entry.link) entries.delete(id);
    },
    stop(): void {
      for (const entry of entries.values()) {
        clearTimeout(entry.pair_timer);
        entry.link?.close();
      }
    },
  };
}
