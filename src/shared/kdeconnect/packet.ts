// KDE Connect's packets as they cross the wire: one JSON object per line, with a type, a body and an optional payload
// sent beside it on a connection of its own. Pure, so the daemon, the tests and the page all read the same shapes.

// ── Shapes ───────────────────────────────────────────────────────────────────

export type PacketBody = Record<string, unknown>;

export interface Packet<Body extends PacketBody = PacketBody> {
  // Unused by every current implementation, but still sent.
  id: number;
  type: string;
  body: Body;
  payloadSize?: number;
  payloadTransferInfo?: { port?: number } & Record<string, unknown>;
}

export const device_types = ["desktop", "laptop", "phone", "tablet", "tv"] as const;

export type DeviceType = (typeof device_types)[number];

export interface IdentityBody extends PacketBody {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  protocolVersion: number;
  incomingCapabilities: string[];
  outgoingCapabilities: string[];
  // Only in the UDP broadcast and the plain first packet on TCP.
  tcpPort?: number;
  // Only in the plain first packet on TCP, naming the device it was meant for.
  targetDeviceId?: string;
  targetProtocolVersion?: number;
}

// ── Protocol constants ───────────────────────────────────────────────────────

export const protocol_version = 8;

export const identity_type = "kdeconnect.identity";
export const pair_type = "kdeconnect.pair";

// The ports every KDE Connect device uses unless told otherwise.
export const discovery_port = 1716;
export const lowest_tcp_port = 1716;
export const highest_tcp_port = 1764;
export const lowest_payload_port = 1739;
export const highest_payload_port = 1764;

// An identity longer than this is refused before it is parsed.
export const most_identity_bytes = 8192;

const type_pattern = /^kdeconnect(\.[a-z_]+)+$/;

// ── Making and reading ───────────────────────────────────────────────────────

export function make_packet<Body extends PacketBody>(type: string, body: Body): Packet<Body> {
  return { id: Date.now(), type, body };
}

export function serialize_packet(packet: Packet): string {
  return `${JSON.stringify(packet)}\n`;
}

// A packet from one line of text, or null when the line is not one.
export function parse_packet(line: string): Packet | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const packet = value as Partial<Packet>;
  if (typeof packet.type !== "string" || !type_pattern.test(packet.type)) return null;
  if (!packet.body || typeof packet.body !== "object" || Array.isArray(packet.body)) return null;
  const result: Packet = { id: typeof packet.id === "number" ? packet.id : 0, type: packet.type, body: packet.body };
  if (typeof packet.payloadSize === "number") result.payloadSize = packet.payloadSize;
  if (packet.payloadTransferInfo && typeof packet.payloadTransferInfo === "object") result.payloadTransferInfo = packet.payloadTransferInfo;
  return result;
}

// Splits text arriving in pieces into whole lines, holding back the unfinished end.
export function create_line_reader(on_line: (line: string) => void): { push(chunk: string): void; pending(): number } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) on_line(line);
        end = buffer.indexOf("\n");
      }
    },
    pending: () => buffer.length,
  };
}

// ── Identity ─────────────────────────────────────────────────────────────────

// A new device id: 32 lowercase hex digits, as current KDE Connect makes them.
export function new_device_id(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

// Old ids may hold hyphens and underscores, and must still be accepted.
export function is_device_id(text: unknown): text is string {
  return typeof text === "string" && /^[A-Za-z0-9_-]{32,38}$/.test(text);
}

const forbidden_name_characters = /["',;:.!?()[\]<>]/g;

// A name every implementation accepts: 1 to 32 characters, none of those the protocol forbids.
export function clean_device_name(name: string): string {
  const cleaned = name.replace(forbidden_name_characters, "").trim().slice(0, 32).trim();
  return cleaned || "X-Control";
}

function is_string_list(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// The identity's body when it is one this side can talk to, else null.
export function read_identity(packet: Packet | null): IdentityBody | null {
  if (!packet || packet.type !== identity_type) return null;
  const body = packet.body;
  if (!is_device_id(body.deviceId)) return null;
  if (typeof body.protocolVersion !== "number" || body.protocolVersion < protocol_version) return null;
  return {
    ...body,
    deviceId: body.deviceId,
    deviceName: typeof body.deviceName === "string" ? clean_device_name(body.deviceName) : "Unnamed device",
    deviceType: device_types.includes(body.deviceType as DeviceType) ? (body.deviceType as DeviceType) : "desktop",
    protocolVersion: body.protocolVersion,
    incomingCapabilities: is_string_list(body.incomingCapabilities) ? body.incomingCapabilities : [],
    outgoingCapabilities: is_string_list(body.outgoingCapabilities) ? body.outgoingCapabilities : [],
  };
}
