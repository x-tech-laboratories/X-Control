// One encrypted connection to another KDE Connect device, once both sides have said who they are: packets go out as
// lines and come in as lines, and a packet's payload travels on a connection of its own.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createServer, connect as connect_tcp, type Server } from "node:net";
import { connect as connect_tls, TLSSocket, type SecureContext } from "node:tls";
import type { Readable } from "node:stream";

import { create_line_reader, highest_payload_port, lowest_payload_port, parse_packet, serialize_packet, type IdentityBody, type Packet } from "../../shared/kdeconnect/packet.ts";
import { same_certificate } from "./identity.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// A payload offered with an incoming packet, fetched only when a plugin opens it.
export interface IncomingPayload {
  size: number;
  open(): Promise<Readable>;
}

// A payload to send: its size, and the bytes as a stream made when the other side connects.
export interface OutgoingPayload {
  size: number;
  open(): Readable | Promise<Readable>;
}

export interface LinkHandlers {
  on_packet(packet: Packet, payload: IncomingPayload | null): void;
  on_close(): void;
}

export interface DeviceLink {
  identity: IdentityBody;
  certificate: string;
  address: string;
  send(packet: Packet, payload?: OutgoingPayload): Promise<void>;
  close(): void;
  is_open(): boolean;
  set_handlers(handlers: LinkHandlers): void;
}

export interface LinkOptions {
  secure_context: SecureContext;
  // The ports a payload is offered on, the first free one taken.
  payload_ports?: { lowest: number; highest: number };
  // How long a payload waits for the other side to fetch it.
  payload_wait_in_milliseconds?: number;
}

const default_payload_wait_in_milliseconds = 10_000;

// ── Payload server ───────────────────────────────────────────────────────────

function listen_on_free_port(server: Server, lowest: number, highest: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number): void => {
      if (port > highest) return reject(new Error(`no free port between ${lowest} and ${highest} for a payload`));
      const on_error = (error: NodeJS.ErrnoException): void => {
        server.off("listening", on_listening);
        if (error.code === "EADDRINUSE" || error.code === "EACCES") attempt(port + 1);
        else reject(error);
      };
      const on_listening = (): void => {
        server.off("error", on_error);
        resolve(port);
      };
      server.once("error", on_error);
      server.once("listening", on_listening);
      server.listen(port);
    };
    attempt(lowest);
  });
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
  const server = createServer((socket) => {
    server.close();
    clearTimeout(timer);
    const secure = new TLSSocket(socket, { isServer: true, secureContext: options.secure_context, requestCert: true, rejectUnauthorized: false });
    secure.on("error", (error) => fail(error));
    secure.once("secure", async () => {
      const certificate = secure.getPeerX509Certificate();
      if (!certificate || !same_certificate(certificate.toString(), peer_certificate)) {
        secure.destroy();
        return fail(new Error("the device fetching the payload is not the one it was offered to"));
      }
      try {
        const stream = await payload.open();
        stream.on("error", (error) => (secure.destroy(), fail(error)));
        stream.pipe(secure);
        secure.on("finish", finish);
        secure.on("close", finish);
      } catch (error) {
        secure.destroy();
        fail(error as Error);
      }
    });
  });
  const timer = setTimeout(() => {
    server.close();
    fail(new Error("the device never fetched the payload"));
  }, wait);
  try {
    const port = await listen_on_free_port(server, ports.lowest, ports.highest);
    return { port, done };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

// Fetches a payload the other side offered, checking it is the same device as on the link.
function fetch_payload(address: string, port: number, options: LinkOptions, peer_certificate: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const socket = connect_tcp({ host: address, port }, () => {
      const secure = connect_tls({ socket, secureContext: options.secure_context, rejectUnauthorized: false, checkServerIdentity: () => undefined });
      secure.once("secureConnect", () => {
        const certificate = secure.getPeerX509Certificate();
        if (!certificate || !same_certificate(certificate.toString(), peer_certificate)) {
          secure.destroy();
          return reject(new Error("the payload came from another device than the one on the link"));
        }
        resolve(secure);
      });
      secure.once("error", reject);
    });
    socket.once("error", reject);
  });
}

// ── Link ─────────────────────────────────────────────────────────────────────

// Wraps a socket that has finished the handshake; text already read past the identity is handed in as leftover.
export function create_link(socket: TLSSocket, identity: IdentityBody, certificate: string, options: LinkOptions, leftover = ""): DeviceLink {
  const address = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
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

  socket.setEncoding("utf8");
  socket.setKeepAlive(true, 10_000);
  socket.on("data", (chunk: string) => reader.push(chunk));
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    open = false;
    handlers?.on_close();
  });
  if (leftover) reader.push(leftover);
  // The handshake paused the socket after the identity, so packets flow only once they have somewhere to go.
  socket.resume();

  return {
    identity,
    certificate,
    address,
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
      await new Promise<void>((resolve, reject) => socket.write(serialize_packet(packet), (error) => (error ? reject(error) : resolve())));
      if (transfer) await transfer;
    },
    close() {
      open = false;
      socket.destroy();
    },
  };
}
