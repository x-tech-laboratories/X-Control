// One KDE Connect device over Bluetooth, once its identity is known: packets as lines on the multiplexer's default
// channel and each payload on a channel of its own. There is no TLS, as on every KDE Connect Bluetooth link, so the
// identity carries the certificate, which must name the device and, once paired, be the one it paired with.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { create_line_reader, identity_type, make_packet, parse_packet, read_identity, type IdentityBody, type Packet } from "../../../shared/kdeconnect/packet.ts";
import { common_name_of, same_certificate, type DeviceIdentity } from "../identity.ts";
import type { DeviceLink, IncomingPayload, LinkHandlers } from "../link.ts";
import type { Mux } from "./mux.ts";

// ── Packets ──────────────────────────────────────────────────────────────────

// A packet as one line of ASCII, since Android reads a Bluetooth identity a byte at a time and mangles anything else.
export function ascii_line(packet: Packet): string {
  return `${JSON.stringify(packet).replace(/[\u0080-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

// A certificate as Android takes it: the header and footer each on a line of their own, ending in a newline.
export function exact_pem(certificate: string): string {
  const body = certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

// A certificate from an identity, which some devices send without its header and footer.
export function certificate_of(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.includes("-----BEGIN CERTIFICATE-----") ? exact_pem(value) : exact_pem(`-----BEGIN CERTIFICATE-----${value}-----END CERTIFICATE-----`);
}

// The largest identity line read, as Valent caps it.
const identity_limit = 8192;

// Android drops what follows its identity in the same burst, so packets wait this long after the handshake.
const settle_ms = 1000;

// ── Handshake ────────────────────────────────────────────────────────────────

export interface BluetoothHandshakeOptions {
  identity: DeviceIdentity;
  capabilities: { incoming: string[]; outgoing: string[] };
  // The certificate a paired device must show, or null for one not paired.
  trusted_certificate(device_id: string): string | null;
  // The device's Bluetooth address, such as "AA:BB:CC:DD:EE:FF".
  address: string;
  timeout_ms?: number;
}

// Sends this device's identity at once and reads the other's, as Valent does in either role, then checks it.
export async function bluetooth_handshake(mux: Mux, options: BluetoothHandshakeOptions): Promise<DeviceLink> {
  const own: IdentityBody & { certificate: string } = {
    deviceId: options.identity.device_id,
    deviceName: options.identity.name,
    deviceType: options.identity.type,
    protocolVersion: 8,
    incomingCapabilities: options.capabilities.incoming,
    outgoingCapabilities: options.capabilities.outgoing,
    certificate: exact_pem(options.identity.certificate),
  };
  mux.packets.write(ascii_line(make_packet(identity_type, own)));

  let text = "";
  const first_line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the device sent no identity over Bluetooth")), options.timeout_ms ?? 15_000);
    const on_data = (chunk: Buffer): void => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0 && text.length <= identity_limit) return;
      mux.packets.off("data", on_data);
      mux.packets.pause();
      clearTimeout(timer);
      if (end < 0) return reject(new Error("the device's identity is too long"));
      resolve(text.slice(0, end));
      text = text.slice(end + 1);
    };
    mux.packets.on("data", on_data);
    void mux.closed.then(() => (clearTimeout(timer), reject(new Error("the Bluetooth connection closed during the handshake"))));
  });

  const packet = parse_packet(first_line);
  const identity = read_identity(packet);
  if (!identity) throw new Error("the device sent no identity this version understands");
  if (identity.deviceId === options.identity.device_id) throw new Error("the device is this one");
  const certificate = certificate_of(packet?.body.certificate);
  if (!certificate) throw new Error("the device sent no certificate");
  if (common_name_of(certificate) !== identity.deviceId) throw new Error("the device's certificate names another device");
  const trusted = options.trusted_certificate(identity.deviceId);
  if (trusted && !same_certificate(trusted, certificate)) throw new Error(`${identity.deviceName} showed a different certificate than when it was paired`);
  return create_bluetooth_link(mux, identity, certificate, options.address, text);
}

// ── Link ─────────────────────────────────────────────────────────────────────

export function create_bluetooth_link(mux: Mux, identity: IdentityBody, certificate: string, address: string, leftover = ""): DeviceLink {
  let handlers: LinkHandlers | null = null;
  let queued: Packet[] = [];
  let open = true;
  const ready_at = Date.now() + settle_ms;

  const deliver = (packet: Packet): void => {
    if (!handlers) return void queued.push(packet);
    const uuid = packet.payloadTransferInfo?.uuid;
    const payload: IncomingPayload | null =
      typeof uuid === "string" && uuid ? { size: typeof packet.payloadSize === "number" ? packet.payloadSize : -1, open: async (): Promise<Readable> => mux.wait_for_channel(uuid) } : null;
    handlers.on_packet(packet, payload);
  };
  const reader = create_line_reader((line) => {
    const packet = parse_packet(line);
    if (packet) deliver(packet);
  });
  if (leftover) reader.push(leftover);
  mux.packets.on("data", (chunk: Buffer) => reader.push(chunk.toString("utf8")));
  mux.packets.resume();
  void mux.closed.then(() => {
    open = false;
    handlers?.on_close();
  });

  const write_line = (line: string): Promise<void> => new Promise((resolve, reject) => mux.packets.write(line, (error) => (error ? reject(error) : resolve())));

  return {
    identity,
    certificate,
    address,
    priority: 10,
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
      const wait = ready_at - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!payload) return write_line(ascii_line(packet));
      // The channel is opened before the packet names it, so the other side knows it when it looks.
      const channel = mux.open_channel();
      await write_line(ascii_line({ ...packet, payloadSize: payload.size, payloadTransferInfo: { uuid: channel.uuid } }));
      await pipeline(await payload.open(), channel);
    },
    close() {
      open = false;
      mux.close();
    },
  };
}
