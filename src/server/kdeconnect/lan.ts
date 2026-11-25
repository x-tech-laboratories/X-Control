// KDE Connect on the local network: this device's identity broadcast over UDP, and the TCP handshake that follows,
// where the device that heard the broadcast connects, says who it is in plain text, and then takes TLS's server part.
// After TLS both sides say who they are again, and a device whose certificate does not match its id is refused.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, connect as connect_tcp, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { connect as connect_tls, createSecureContext, TLSSocket } from "node:tls";

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
  type IdentityBody,
} from "../../shared/kdeconnect/packet.ts";
import { common_name_of, same_certificate, type DeviceIdentity } from "./identity.ts";
import { create_link, type DeviceLink, type LinkOptions } from "./link.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface LanOptions {
  identity: () => DeviceIdentity;
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
  // Where broadcasts go; every interface's broadcast address unless given.
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

function every_broadcast_address(): string[] {
  const found = new Set<string>(["255.255.255.255"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const ip = address.address.split(".").map(Number);
      const mask = address.netmask.split(".").map(Number);
      found.add(ip.map((part, index) => (part | (~mask[index]! & 255)) >>> 0).join("."));
    }
  }
  return [...found];
}

function plain_address(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/, "");
}

function is_loopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}

// Reads one line of text from a socket, refusing more than an identity can hold, and hands over what came after it.
function read_first_line(socket: Socket | TLSSocket): Promise<{ line: string; rest: string }> {
  return new Promise((resolve, reject) => {
    let text = "";
    const on_data = (chunk: Buffer): void => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end >= 0) {
        socket.off("data", on_data);
        socket.pause();
        resolve({ line: text.slice(0, end), rest: text.slice(end + 1) });
      } else if (text.length > most_identity_bytes) {
        socket.off("data", on_data);
        reject(new Error("identity too long"));
      }
    };
    socket.on("data", on_data);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before saying who it is")));
  });
}

// Reads the identity sent over TLS, then hands over whatever came after it.
async function read_secure_identity(socket: TLSSocket): Promise<{ identity: IdentityBody; rest: string }> {
  const { line, rest } = await read_first_line(socket);
  const identity = read_identity(parse_packet(line));
  if (!identity) throw new Error("the identity sent over TLS is not one this device can talk to");
  return { identity, rest };
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

// ── Backend ──────────────────────────────────────────────────────────────────

export function create_lan_backend(options: LanOptions): LanBackend {
  const tcp_ports = options.tcp_ports ?? { lowest: lowest_tcp_port, highest: highest_tcp_port };
  const listen_port = options.listen_port ?? discovery_port;
  const announce_port = options.announce_port ?? discovery_port;
  const warn = options.on_warning ?? (() => {});
  const last_attempt = new Map<string, number>();
  let udp: UdpSocket | null = null;
  let tcp: Server | null = null;
  let port = 0;
  let announce_timer: ReturnType<typeof setInterval> | undefined;
  // Every socket opened, so stopping can close them rather than wait for them.
  const sockets = new Set<Socket>();

  function track(socket: Socket): Socket {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }

  // Settles when TLS is up, and fails when the socket closes or errs first.
  function secured(socket: TLSSocket, event: "secure" | "secureConnect"): Promise<void> {
    return with_timeout(
      new Promise<void>((resolve, reject) => {
        socket.once(event, resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("closed during the handshake")));
      }),
      () => socket.destroy(),
    );
  }

  const secure_context = () => createSecureContext({ key: options.identity().private_key, cert: options.identity().certificate });
  const link_options = (): LinkOptions => ({ secure_context: secure_context(), payload_ports: options.payload_ports });

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
  function finish_handshake(socket: TLSSocket, first: IdentityBody, second: IdentityBody, rest: string): void {
    if (second.deviceId !== first.deviceId || second.protocolVersion !== first.protocolVersion) throw new Error("the device changed who it is during the handshake");
    const peer = socket.getPeerX509Certificate();
    if (!peer) throw new Error("the device showed no certificate");
    const certificate = peer.toString();
    if (common_name_of(certificate) !== second.deviceId) throw new Error("the device's certificate names another device");
    const trusted = options.trusted_certificate(second.deviceId);
    if (trusted && !same_certificate(trusted, certificate)) throw new Error(`${second.deviceName} showed a different certificate than when it was paired`);
    options.on_link(create_link(socket, second, certificate, link_options(), rest));
  }

  // This side heard of the device, so it connects, says who it is plainly, and takes TLS's server part.
  async function connect(address: string, tcp_port: number, device_id?: string, target_version = protocol_version): Promise<void> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const opened = track(connect_tcp({ host: address, port: tcp_port }, () => resolve(opened)));
      opened.once("error", reject);
    });
    const first = identity_body({ tcpPort: port, ...(device_id ? { targetDeviceId: device_id, targetProtocolVersion: target_version } : {}) });
    socket.write(serialize_packet(make_packet(identity_type, first)));
    const secure = new TLSSocket(socket, { isServer: true, secureContext: secure_context(), requestCert: true, rejectUnauthorized: false });
    try {
      await secured(secure, "secure");
      secure.write(serialize_packet(make_packet(identity_type, identity_body())));
      const { identity, rest } = await with_timeout(read_secure_identity(secure), () => secure.destroy());
      if (device_id && identity.deviceId !== device_id) throw new Error("another device answered at that address");
      finish_handshake(secure, identity, identity, rest);
    } catch (error) {
      secure.destroy();
      throw error;
    }
  }

  // The device heard this one's broadcast and connected: it says who it is plainly, then this side takes TLS's client part.
  async function accept(socket: Socket): Promise<void> {
    const address = plain_address(socket.remoteAddress);
    if (!options.allow_loopback && is_loopback(address)) return void socket.destroy();
    try {
      const { line } = await with_timeout(read_first_line(socket), () => socket.destroy());
      const first = read_identity(parse_packet(line));
      if (!first) throw new Error(`${address} sent no identity this device can talk to`);
      const own = options.identity().device_id;
      if (first.deviceId === own) throw new Error("heard its own identity");
      if (first.targetDeviceId !== undefined && first.targetDeviceId !== own) throw new Error(`${first.deviceName} was looking for another device`);
      const secure = connect_tls({ socket, secureContext: secure_context(), rejectUnauthorized: false, checkServerIdentity: () => undefined });
      try {
        await secured(secure, "secureConnect");
        secure.write(serialize_packet(make_packet(identity_type, identity_body())));
        const { identity, rest } = await with_timeout(read_secure_identity(secure), () => secure.destroy());
        finish_handshake(secure, first, identity, rest);
      } catch (error) {
        secure.destroy();
        throw error;
      }
    } catch (error) {
      socket.destroy();
      warn(`connection from ${address} refused: ${(error as Error).message}`);
    }
  }

  function on_datagram(message: Buffer, sender: { address: string }): void {
    const address = plain_address(sender.address);
    if (!options.allow_loopback && is_loopback(address)) return;
    const identity = read_identity(parse_packet(message.toString("utf8")));
    if (!identity || identity.deviceId === options.identity().device_id || typeof identity.tcpPort !== "number") return;
    if (identity.tcpPort < tcp_ports.lowest || identity.tcpPort > tcp_ports.highest) return;
    if (options.is_connected?.(identity.deviceId) || too_soon(identity.deviceId)) return;
    connect(address, identity.tcpPort, identity.deviceId, identity.protocolVersion).catch((error: unknown) => warn(`could not connect to ${identity.deviceName} at ${address}: ${(error as Error).message}`));
  }

  function announce(address?: string, to_port = announce_port): void {
    if (!udp || !port) return;
    const datagram = Buffer.from(serialize_packet(make_packet(identity_type, identity_body({ tcpPort: port }))));
    const everyone = () => [...new Set([...(options.discovery === false ? [] : (options.broadcast_addresses ?? every_broadcast_address)()), ...(options.known_addresses?.() ?? [])])];
    for (const target of address ? [address] : everyone()) {
      udp.send(datagram, to_port, target, (error) => {
        if (error) warn(`could not announce to ${target}: ${error.message}`);
      });
    }
  }

  async function start_tcp(): Promise<void> {
    for (let candidate = tcp_ports.lowest; candidate <= tcp_ports.highest; candidate++) {
      const server = createServer((socket) => void accept(track(socket) as Socket));
      const listened = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(candidate, () => resolve(true));
      });
      if (listened) {
        tcp = server;
        port = (server.address() as { port: number }).port;
        return;
      }
    }
    throw new Error(`no free TCP port between ${tcp_ports.lowest} and ${tcp_ports.highest}`);
  }

  async function start_udp(): Promise<void> {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", on_datagram);
    socket.on("error", (error) => warn(`discovery: ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(options.discovery === false ? 0 : listen_port, () => (socket.off("error", reject), resolve()));
    });
    socket.setBroadcast(true);
    udp = socket;
  }

  return {
    async start() {
      await start_tcp();
      await start_udp();
      announce();
      announce_timer = setInterval(() => announce(), announce_interval_in_milliseconds);
    },
    async stop() {
      clearInterval(announce_timer);
      udp?.close();
      udp = null;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => (tcp ? tcp.close(() => resolve()) : resolve()));
      tcp = null;
    },
    announce,
    connect: (address, tcp_port, device_id) => connect(address, tcp_port, device_id),
    tcp_port: () => port,
  };
}
