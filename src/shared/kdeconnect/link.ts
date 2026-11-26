// One encrypted connection to another KDE Connect device, once both sides have said who they are: packets go out as
// lines and come in as lines, and a packet's payload travels on a connection of its own. It runs over any NetSockets,
// Node's on a computer and the phone service's on a phone.

// ── Imports ──────────────────────────────────────────────────────────────────

import { same_certificate } from "./certificates.ts";
import { create_line_reader, highest_payload_port, lowest_payload_port, parse_packet, serialize_packet, type IdentityBody, type Packet } from "./packet.ts";
import { bytes_of, type NetServer, type NetSockets, type NetStream } from "./sockets.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// A payload's bytes, such as a Node stream or a phone socket's chunks.
export type PayloadBytes = AsyncIterable<Uint8Array>;

// A payload offered with an incoming packet, fetched only when a plugin opens it.
export interface IncomingPayload {
  size: number;
  open(): Promise<PayloadBytes>;
}

// A payload to send: its size, and the bytes, made when the other side connects.
export interface OutgoingPayload {
  size: number;
  open(): PayloadBytes | Promise<PayloadBytes>;
}

export interface LinkHandlers {
  on_packet(packet: Packet, payload: IncomingPayload | null): void;
  on_close(): void;
}

export interface DeviceLink {
  identity: IdentityBody;
  certificate: string;
  address: string;
  // Which link a device keeps when it has two, as KDE Connect ranks them: LAN 20, Bluetooth 10.
  priority: number;
  send(packet: Packet, payload?: OutgoingPayload): Promise<void>;
  close(): void;
  is_open(): boolean;
  set_handlers(handlers: LinkHandlers): void;
}

export interface LinkOptions {
  sockets: NetSockets;
  // This device's certificate and key, for TLS on the payload connections.
  certificate: string;
  key: string;
  // The ports a payload is offered on, the first free one taken.
  payload_ports?: { lowest: number; highest: number };
  // How long a payload waits for the other side to fetch it.
  payload_wait_in_milliseconds?: number;
}

const default_payload_wait_in_milliseconds = 10_000;

// ── Payloads ─────────────────────────────────────────────────────────────────

async function listen_on_free_port(sockets: NetSockets, lowest: number, highest: number, on_connection: (stream: NetStream) => void): Promise<NetServer> {
  for (let port = lowest; port <= highest; port++) {
    try {
      return await sockets.tcp_listen(port, on_connection);
    } catch {
      // Taken; the next one is tried.
    }
  }
  throw new Error(`no free port between ${lowest} and ${highest} for a payload`);
}

// Offers a payload on a port of its own; the other side connects and takes TLS's client part, as in the handshake.
async function offer_payload(payload: OutgoingPayload, options: LinkOptions, peer_certificate: string): Promise<{ port: number; done: Promise<void> }> {
  const ports = options.payload_ports ?? { lowest: lowest_payload_port, highest: highest_payload_port };
  const wait = options.payload_wait_in_milliseconds ?? default_payload_wait_in_milliseconds;
  let finish: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let server: NetServer | null = null;
  let taken = false;

  const send_to = async (stream: NetStream): Promise<void> => {
    try {
      const { peer_certificate: certificate } = await stream.start_tls({ role: "server", certificate: options.certificate, key: options.key });
      if (!certificate || !same_certificate(certificate, peer_certificate)) throw new Error("the device fetching the payload is not the one it was offered to");
      for await (const chunk of await payload.open()) await stream.write(chunk);
      await stream.end();
      finish();
    } catch (error) {
      stream.destroy();
      fail(error as Error);
    }
  };

  const timer = setTimeout(() => {
    server?.close();
    fail(new Error("the device never fetched the payload"));
  }, wait);
  server = await listen_on_free_port(options.sockets, ports.lowest, ports.highest, (stream) => {
    // Only the first connection fetches the payload.
    if (taken) return stream.destroy();
    taken = true;
    server?.close();
    clearTimeout(timer);
    void send_to(stream);
  }).catch((error: unknown) => {
    clearTimeout(timer);
    throw error;
  });
  return { port: server.port, done };
}

// Fetches a payload the other side offered, checking it is the same device as on the link.
async function fetch_payload(address: string, port: number, options: LinkOptions, peer_certificate: string): Promise<PayloadBytes> {
  const stream = await options.sockets.tcp_connect(address, port);
  try {
    const { peer_certificate: certificate } = await stream.start_tls({ role: "client", certificate: options.certificate, key: options.key });
    if (!certificate || !same_certificate(certificate, peer_certificate)) throw new Error("the payload came from another device than the one on the link");
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return bytes_of(stream);
}

// ── Link ─────────────────────────────────────────────────────────────────────

// Wraps a stream that has finished the handshake, with TLS up and nothing read past the second identity.
export function create_link(stream: NetStream, identity: IdentityBody, certificate: string, options: LinkOptions): DeviceLink {
  const address = stream.remote_address.replace(/^::ffff:/, "");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let handlers: LinkHandlers | null = null;
  let queued: Packet[] = [];
  let open = true;

  const deliver = (packet: Packet): void => {
    if (!handlers) return void queued.push(packet);
    const port = packet.payloadTransferInfo?.port;
    const payload: IncomingPayload | null =
      typeof port === "number" && typeof packet.payloadSize === "number"
        ? { size: packet.payloadSize, open: () => fetch_payload(address, port, options, certificate) }
        : null;
    handlers.on_packet(packet, payload);
  };

  const reader = create_line_reader((line) => {
    const packet = parse_packet(line);
    if (packet) deliver(packet);
  });

  stream.start_reading(
    (bytes) => reader.push(decoder.decode(bytes, { stream: true })),
    () => {
      open = false;
      handlers?.on_close();
    },
  );

  return {
    identity,
    certificate,
    address,
    priority: 20,
    is_open: () => open,
    set_handlers(given) {
      handlers = given;
      const waiting = queued;
      queued = [];
      for (const packet of waiting) deliver(packet);
      if (!open) given.on_close();
    },
    async send(packet, payload) {
      if (!open) throw new Error(`${identity.deviceName} is not connected`);
      let transfer: Promise<void> | null = null;
      if (payload) {
        const offer = await offer_payload(payload, options, certificate);
        packet = { ...packet, payloadSize: payload.size, payloadTransferInfo: { port: offer.port } };
        transfer = offer.done;
      }
      await stream.write(encoder.encode(serialize_packet(packet)));
      if (transfer) await transfer;
    },
    close() {
      open = false;
      stream.destroy();
    },
  };
}
