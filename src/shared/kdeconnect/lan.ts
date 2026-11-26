// KDE Connect on the local network: this device's identity broadcast over UDP, and the TCP handshake that follows,
// where the device that heard the broadcast connects, says who it is in plain text, and then takes TLS's server part.
// After TLS both sides say who they are again, and a device whose certificate does not match its id is refused.
// It runs over any NetSockets, Node's on a computer and the phone service's on a phone.

// ── Imports ──────────────────────────────────────────────────────────────────

import { common_name_of, same_certificate } from "./certificates.ts";
import { create_link, type DeviceLink, type LinkOptions } from "./link.ts";
import {
  discovery_port,
  highest_tcp_port,
  identity_type,
  lowest_tcp_port,
  make_packet,
  most_identity_bytes,
  parse_packet,
  protocol_version,
  read_identity,
  serialize_packet,
  type DeviceType,
  type IdentityBody,
} from "./packet.ts";
import type { NetServer, NetSockets, NetStream, NetUdp } from "./sockets.ts";

// ── Options ──────────────────────────────────────────────────────────────────

// This device as the handshake needs it.
export interface LanIdentity {
  device_id: string;
  name: string;
  type: DeviceType;
  certificate: string;
  private_key: string;
}

export interface LanOptions {
  sockets: NetSockets;
  identity: () => LanIdentity;
  // The packet types this device takes and sends, read each time it says who it is.
  capabilities: () => { incoming: string[]; outgoing: string[] };
  // The certificate a paired device must show, or null for one not yet paired.
  trusted_certificate: (device_id: string) => string | null;
  on_link: (link: DeviceLink) => void;
  // Whether a device is already connected, so a second broadcast from it starts no second handshake.
  is_connected?: (device_id: string) => boolean;
  // The UDP port this device hears broadcasts on, and the one it sends its own to.
  listen_port?: number;
  announce_port?: number;
  tcp_ports?: { lowest: number; highest: number };
  payload_ports?: LinkOptions["payload_ports"];
  // Where broadcasts go; every network's broadcast address unless given.
  broadcast_addresses?: () => string[];
  // Addresses told of this device on every announcement besides the broadcast, such as paired devices' last ones.
  known_addresses?: () => string[];
  // Off turns broadcasting and listening for broadcasts off, leaving only connections made by hand.
  discovery?: boolean;
  // Loopback is ignored on a real network, but tests run there.
  allow_loopback?: boolean;
  on_warning?: (message: string) => void;
}

export interface LanBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Says who this device is to every device on the network, or to one address.
  announce(address?: string, port?: number): void;
  // Connects to a device at an address directly, as discovery would.
  connect(address: string, port: number, device_id?: string): Promise<void>;
  tcp_port(): number;
}

const handshake_timeout_in_milliseconds = 5000;
const announce_interval_in_milliseconds = 60_000;
const quiet_between_attempts_in_milliseconds = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function plain_address(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/, "");
}

function is_loopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}

function with_timeout<Value>(work: Promise<Value>, on_timeout: () => void): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      on_timeout();
      reject(new Error("the handshake took too long"));
    }, handshake_timeout_in_milliseconds);
    work.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error: unknown) => (clearTimeout(timer), reject(error)),
    );
  });
}

// Reads the identity a stream sends as its next line.
async function read_identity_line(stream: NetStream): Promise<IdentityBody | null> {
  return read_identity(parse_packet(await stream.read_line(most_identity_bytes)));
}

// ── Backend ──────────────────────────────────────────────────────────────────

export function create_lan(options: LanOptions): LanBackend {
  const { sockets } = options;
  const tcp_ports = options.tcp_ports ?? { lowest: lowest_tcp_port, highest: highest_tcp_port };
  const listen_port = options.listen_port ?? discovery_port;
  const announce_port = options.announce_port ?? discovery_port;
  const warn = options.on_warning ?? (() => {});
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const last_attempt = new Map<string, number>();
  let udp: NetUdp | null = null;
  let tcp: NetServer | null = null;
  let port = 0;
  let broadcast_addresses: string[] = [];
  let announce_timer: ReturnType<typeof setInterval> | undefined;
  // Every stream mid-handshake and every link made, so stopping can close them rather than wait for them.
  const streams = new Set<NetStream>();
  const links = new Set<DeviceLink>();

  const tls = (role: "client" | "server") => ({ role, certificate: options.identity().certificate, key: options.identity().private_key });
  const link_options = (): LinkOptions => ({ sockets, certificate: options.identity().certificate, key: options.identity().private_key, payload_ports: options.payload_ports });
  const line = (body: IdentityBody) => encoder.encode(serialize_packet(make_packet(identity_type, body)));

  function identity_body(extra: Partial<IdentityBody> = {}): IdentityBody {
    const identity = options.identity();
    const capabilities = options.capabilities();
    return {
      deviceId: identity.device_id,
      deviceName: identity.name,
      deviceType: identity.type,
      protocolVersion: protocol_version,
      incomingCapabilities: capabilities.incoming,
      outgoingCapabilities: capabilities.outgoing,
      ...extra,
    };
  }

  // A device heard from too recently is skipped, so a burst of broadcasts starts one handshake.
  function too_soon(key: string): boolean {
    const now = Date.now();
    const last = last_attempt.get(key) ?? 0;
    last_attempt.set(key, now);
    if (last_attempt.size > 1024) last_attempt.clear();
    return now - last < quiet_between_attempts_in_milliseconds;
  }

  // Both identities must agree, the certificate must name the device, and a paired device must show its own.
  function finish_handshake(stream: NetStream, peer: string | null, first: IdentityBody, second: IdentityBody): void {
    if (second.deviceId !== first.deviceId || second.protocolVersion !== first.protocolVersion) throw new Error("the device changed who it is during the handshake");
    if (!peer) throw new Error("the device showed no certificate");
    if (common_name_of(peer) !== second.deviceId) throw new Error("the device's certificate names another device");
    const trusted = options.trusted_certificate(second.deviceId);
    if (trusted && !same_certificate(trusted, peer)) throw new Error(`${second.deviceName} showed a different certificate than when it was paired`);
    const link = create_link(stream, second, peer, link_options());
    streams.delete(stream);
    for (const kept of links) if (!kept.is_open()) links.delete(kept);
    links.add(link);
    options.on_link(link);
  }

  function track(stream: NetStream): NetStream {
    streams.add(stream);
    return stream;
  }

  // Says who this device is over TLS and reads who the other side is, then hands over the link.
  async function secure_exchange(stream: NetStream, role: "client" | "server", first: IdentityBody | null, device_id?: string): Promise<void> {
    const { peer_certificate } = await with_timeout(stream.start_tls(tls(role)), () => stream.destroy());
    await stream.write(line(identity_body()));
    const identity = await with_timeout(read_identity_line(stream), () => stream.destroy());
    if (!identity) throw new Error("the identity sent over TLS is not one this device can talk to");
    if (device_id && identity.deviceId !== device_id) throw new Error("another device answered at that address");
    finish_handshake(stream, peer_certificate, first ?? identity, identity);
  }

  // This side heard of the device, so it connects, says who it is plainly, and takes TLS's server part.
  async function connect(address: string, tcp_port: number, device_id?: string, target_version = protocol_version): Promise<void> {
    const stream = track(await sockets.tcp_connect(address, tcp_port));
    try {
      await stream.write(line(identity_body({ tcpPort: port, ...(device_id ? { targetDeviceId: device_id, targetProtocolVersion: target_version } : {}) })));
      await secure_exchange(stream, "server", null, device_id);
    } catch (error) {
      stream.destroy();
      streams.delete(stream);
      throw error;
    }
  }

  // The device heard this one's broadcast and connected: it says who it is plainly, then this side takes TLS's client part.
  async function accept(stream: NetStream): Promise<void> {
    const address = plain_address(stream.remote_address);
    if (!options.allow_loopback && is_loopback(address)) return void stream.destroy();
    track(stream);
    try {
      const first = await with_timeout(read_identity_line(stream), () => stream.destroy());
      if (!first) throw new Error(`${address} sent no identity this device can talk to`);
      const own = options.identity().device_id;
      if (first.deviceId === own) throw new Error("heard its own identity");
      if (first.targetDeviceId !== undefined && first.targetDeviceId !== own) throw new Error(`${first.deviceName} was looking for another device`);
      await secure_exchange(stream, "client", first);
    } catch (error) {
      stream.destroy();
      streams.delete(stream);
      warn(`connection from ${address} refused: ${(error as Error).message}`);
    }
  }

  function on_datagram(bytes: Uint8Array, sender: string): void {
    const address = plain_address(sender);
    if (!options.allow_loopback && is_loopback(address)) return;
    const identity = read_identity(parse_packet(decoder.decode(bytes)));
    if (!identity || identity.deviceId === options.identity().device_id || typeof identity.tcpPort !== "number") return;
    if (identity.tcpPort < tcp_ports.lowest || identity.tcpPort > tcp_ports.highest) return;
    if (options.is_connected?.(identity.deviceId) || too_soon(identity.deviceId)) return;
    connect(address, identity.tcpPort, identity.deviceId, identity.protocolVersion).catch((error: unknown) => warn(`could not connect to ${identity.deviceName} at ${address}: ${(error as Error).message}`));
  }

  function announce(address?: string, to_port = announce_port): void {
    if (!udp || !port) return;
    const datagram = line(identity_body({ tcpPort: port }));
    const everyone = () => [...new Set([...(options.discovery === false ? [] : (options.broadcast_addresses?.() ?? broadcast_addresses)), ...(options.known_addresses?.() ?? [])])];
    for (const target of address ? [address] : everyone()) {
      udp.send(datagram, target, to_port).catch((error: unknown) => warn(`could not announce to ${target}: ${(error as Error).message}`));
    }
  }

  async function refresh_broadcast_addresses(): Promise<void> {
    if (options.discovery === false || options.broadcast_addresses) return;
    broadcast_addresses = await sockets.broadcast_addresses().catch(() => broadcast_addresses);
  }

  async function start_tcp(): Promise<void> {
    for (let candidate = tcp_ports.lowest; candidate <= tcp_ports.highest; candidate++) {
      try {
        tcp = await sockets.tcp_listen(candidate, (stream) => void accept(stream));
        port = tcp.port;
        return;
      } catch {
        // Taken; the next one is tried.
      }
    }
    throw new Error(`no free TCP port between ${tcp_ports.lowest} and ${tcp_ports.highest}`);
  }

  return {
    async start() {
      await start_tcp();
      await refresh_broadcast_addresses();
      udp = await sockets.udp_open(options.discovery === false ? 0 : listen_port, on_datagram, (error) => warn(`discovery: ${error.message}`));
      announce();
      // The networks can change between announcements, as when a phone moves to another Wi-Fi.
      announce_timer = setInterval(() => void refresh_broadcast_addresses().then(() => announce()), announce_interval_in_milliseconds);
    },
    async stop() {
      clearInterval(announce_timer);
      udp?.close();
      udp = null;
      for (const stream of streams) stream.destroy();
      streams.clear();
      for (const link of links) link.close();
      links.clear();
      tcp?.close();
      tcp = null;
    },
    announce,
    connect: (address, tcp_port, device_id) => connect(address, tcp_port, device_id),
    tcp_port: () => port,
  };
}
