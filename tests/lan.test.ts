import { Readable } from "node:stream";
import { text } from "node:stream/consumers";

import { afterEach, describe, expect, test } from "vitest";

import { make_packet, type Packet } from "../src/shared/kdeconnect/packet.ts";
import { make_certificate, type DeviceIdentity } from "../src/server/kdeconnect/identity.ts";
import { create_lan_backend, type LanBackend } from "../src/server/kdeconnect/lan.ts";
import type { DeviceLink, IncomingPayload } from "../src/server/kdeconnect/link.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function make_identity(name: string, device_id: string): Promise<DeviceIdentity> {
  return { device_id, name, type: "desktop", ...(await make_certificate(device_id)) };
}

// A backend on loopback ports of its own, its links handed to the list given.
async function make_backend(identity: DeviceIdentity, links: DeviceLink[], trusted: Record<string, string> = {}, ports = { tcp: 0 }): Promise<LanBackend> {
  const backend = create_lan_backend({
    identity: () => identity,
    capabilities: () => ({ incoming: ["kdeconnect.ping"], outgoing: ["kdeconnect.ping"] }),
    trusted_certificate: (device_id) => trusted[device_id] ?? null,
    on_link: (link) => links.push(link),
    discovery: false,
    allow_loopback: true,
    tcp_ports: { lowest: 41716 + ports.tcp, highest: 41740 },
    payload_ports: { lowest: 41741, highest: 41764 },
  });
  await backend.start();
  stops.push(() => backend.stop());
  return backend;
}

async function until<Value>(read: () => Value | undefined, what: string): Promise<Value> {
  for (let tries = 0; tries < 200; tries++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waited too long for ${what}`);
}

const first_id = "a".repeat(32);
const second_id = "b".repeat(32);

// ── Handshake ────────────────────────────────────────────────────────────────

describe("the LAN handshake", () => {
  test("connects two devices that each learn the other's identity and certificate", async () => {
    const first = await make_identity("First", first_id);
    const second = await make_identity("Second", second_id);
    const first_links: DeviceLink[] = [];
    const second_links: DeviceLink[] = [];
    await make_backend(first, first_links);
    const listening = await make_backend(second, second_links, {}, { tcp: 5 });

    const connecting = create_lan_backend({
      identity: () => first,
      capabilities: () => ({ incoming: [], outgoing: [] }),
      trusted_certificate: () => null,
      on_link: (link) => first_links.push(link),
      discovery: false,
      allow_loopback: true,
      tcp_ports: { lowest: 41730, highest: 41740 },
    });
    await connecting.start();
    stops.push(() => connecting.stop());
    await connecting.connect("127.0.0.1", listening.tcp_port(), second_id);

    const at_first = await until(() => first_links[0], "the first link");
    const at_second = await until(() => second_links[0], "the second link");
    expect(at_first.identity.deviceName).toBe("Second");
    expect(at_second.identity.deviceName).toBe("First");
    expect(at_second.identity.incomingCapabilities).toEqual([]);
    expect(at_first.certificate).toContain("BEGIN CERTIFICATE");
  });

  test("passes packets both ways and fetches a payload offered with one", async () => {
    const first = await make_identity("First", first_id);
    const second = await make_identity("Second", second_id);
    const first_links: DeviceLink[] = [];
    const second_links: DeviceLink[] = [];
    const from = await make_backend(first, first_links);
    const to = await make_backend(second, second_links, {}, { tcp: 5 });
    await from.connect("127.0.0.1", to.tcp_port(), second_id);
    const sender = await until(() => first_links[0], "the sending link");
    const receiver = await until(() => second_links[0], "the receiving link");

    const received: { packet: Packet; payload: IncomingPayload | null }[] = [];
    receiver.set_handlers({ on_packet: (packet, payload) => received.push({ packet, payload }), on_close: () => {} });
    sender.set_handlers({ on_packet: () => {}, on_close: () => {} });

    await sender.send(make_packet("kdeconnect.ping", { message: "hello" }));
    const ping = await until(() => received[0], "the ping");
    expect(ping.packet.body).toEqual({ message: "hello" });
    expect(ping.payload).toBeNull();

    const content = "a file's contents";
    const sending = sender.send(make_packet("kdeconnect.share.request", { filename: "note.txt" }), { size: content.length, open: () => Readable.from([content]) });
    const share = await until(() => received[1], "the share");
    expect(share.payload?.size).toBe(content.length);
    expect(await text(await share.payload!.open())).toBe(content);
    await sending;
  });

  test("refuses a paired device that shows another certificate", async () => {
    const first = await make_identity("First", first_id);
    const second = await make_identity("Second", second_id);
    const impostor = await make_certificate(first_id);
    const second_links: DeviceLink[] = [];
    const warnings: string[] = [];
    const from = await make_backend(first, []);
    const to = create_lan_backend({
      identity: () => second,
      capabilities: () => ({ incoming: [], outgoing: [] }),
      trusted_certificate: (device_id) => (device_id === first_id ? impostor.certificate : null),
      on_link: (link) => second_links.push(link),
      discovery: false,
      allow_loopback: true,
      tcp_ports: { lowest: 41725, highest: 41740 },
      on_warning: (message) => warnings.push(message),
    });
    await to.start();
    stops.push(() => to.stop());

    await from.connect("127.0.0.1", to.tcp_port(), second_id).catch(() => undefined);
    await until(() => warnings[0], "the refusal");
    expect(warnings[0]).toContain("different certificate");
    expect(second_links).toHaveLength(0);
  });

  test("refuses a connection meant for another device", async () => {
    const first = await make_identity("First", first_id);
    const second = await make_identity("Second", second_id);
    const warnings: string[] = [];
    const from = await make_backend(first, []);
    const to = create_lan_backend({
      identity: () => second,
      capabilities: () => ({ incoming: [], outgoing: [] }),
      trusted_certificate: () => null,
      on_link: () => {},
      discovery: false,
      allow_loopback: true,
      tcp_ports: { lowest: 41725, highest: 41740 },
      on_warning: (message) => warnings.push(message),
    });
    await to.start();
    stops.push(() => to.stop());

    await expect(from.connect("127.0.0.1", to.tcp_port(), "c".repeat(32))).rejects.toThrow();
    await until(() => warnings[0], "the refusal");
    expect(warnings[0]).toContain("looking for another device");
  });
});
