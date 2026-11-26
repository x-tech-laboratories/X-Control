import { randomBytes } from "node:crypto";
import { duplexPair, Readable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { make_certificate, type DeviceIdentity } from "../src/server/kdeconnect/identity.ts";
import { ascii_line, bluetooth_handshake, certificate_of, exact_pem } from "../src/server/kdeconnect/bluetooth/link.ts";
import { buffer_size, create_mux, default_channel, frame, message, uuid_bytes, uuid_text, version_frame, type Mux } from "../src/server/kdeconnect/bluetooth/mux.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const muxes: Mux[] = [];

afterEach(() => {
  for (const mux of muxes.splice(0)) mux.close();
});

function pair(): [Mux, Mux] {
  const [left, right] = duplexPair();
  const muxed: [Mux, Mux] = [create_mux(left), create_mux(right)];
  muxes.push(...muxed);
  return muxed;
}

async function identity(name: string): Promise<DeviceIdentity> {
  const device_id = randomBytes(16).toString("hex");
  return { device_id, name, type: "desktop", ...(await make_certificate(device_id)) };
}

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Every frame on a raw stream, parsed.
function frames_of(bytes: Buffer): { type: number; uuid: string; data: Buffer }[] {
  const found: { type: number; uuid: string; data: Buffer }[] = [];
  let rest = bytes;
  while (rest.length >= 19) {
    const length = rest.readUInt16BE(1);
    found.push({ type: rest[0]!, uuid: uuid_text(rest.subarray(3, 19)), data: rest.subarray(19, 19 + length) });
    rest = rest.subarray(19 + length);
  }
  return found;
}

// ── Multiplexer ──────────────────────────────────────────────────────────────

describe("the multiplexer", () => {
  test("starts with exactly the version message, then a 4096-byte grant on the packet channel", async () => {
    const [ours, theirs] = duplexPair();
    const written: Buffer[] = [];
    theirs.on("data", (chunk: Buffer) => written.push(chunk));
    muxes.push(create_mux(ours));
    await new Promise((resolve) => setImmediate(resolve));
    const bytes = Buffer.concat(written);
    expect(bytes.subarray(0, 23).toString("hex")).toBe(`000004${"00".repeat(16)}00010001`);
    expect(frames_of(bytes)[1]).toEqual({ type: message.read, uuid: default_channel, data: Buffer.from([0x10, 0x00]) });
    expect(uuid_text(uuid_bytes(default_channel))).toBe(default_channel);
    expect(version_frame().length).toBe(23);
  });

  test("carries more than a buffer's worth each way, a payload on its own channel, and never writes beyond the grant", async () => {
    const [left, right] = duplexPair();
    const sizes: number[] = [];
    const a = create_mux(left);
    const b = create_mux(right);
    muxes.push(a, b);
    right.on("data", (chunk: Buffer) => sizes.push(...frames_of(chunk).filter((entry) => entry.type === message.write).map((entry) => entry.data.length)));
    const text = "x".repeat(20_000);
    const got = new Promise<string>((resolve) => {
      let all = "";
      b.packets.on("data", (chunk: Buffer) => {
        all += chunk.toString();
        if (all.length >= text.length) resolve(all);
      });
    });
    a.packets.write(text);
    expect(await got).toBe(text);

    const payload = randomBytes(100_000);
    const channel = a.open_channel();
    const arriving = b.wait_for_channel(channel.uuid).then(collect);
    channel.end(payload);
    expect((await arriving).equals(payload)).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(buffer_size);
  });

  test("closes on a version it does not speak, and on bytes beyond the grant", async () => {
    const [ours, theirs] = duplexPair();
    const mux = create_mux(ours);
    muxes.push(mux);
    const data = Buffer.alloc(4);
    data.writeUInt16BE(2, 0);
    data.writeUInt16BE(3, 2);
    theirs.write(frame(message.protocol_version, default_channel, data));
    await mux.closed;
    expect(mux.is_closed()).toBe(true);

    const [ours2, theirs2] = duplexPair();
    const second = create_mux(ours2);
    muxes.push(second);
    theirs2.write(version_frame());
    // Skipped: an unknown type, and a grant on a channel never opened.
    theirs2.write(frame(9, default_channel, Buffer.from("??")));
    theirs2.write(frame(message.read, "11111111-2222-3333-4444-555555555555", Buffer.from([0, 10])));
    await new Promise((resolve) => setImmediate(resolve));
    expect(second.is_closed()).toBe(false);
    theirs2.write(frame(message.write, default_channel, Buffer.alloc(5000)));
    await second.closed;
    expect(second.is_closed()).toBe(true);
  });
});

// ── Handshake ────────────────────────────────────────────────────────────────

describe("the Bluetooth handshake", () => {
  test("both sides learn each other, packets flow both ways, and a payload goes on its own channel", async () => {
    const [a, b] = pair();
    const [laptop, phone] = await Promise.all([identity("Laptop"), identity("Phone ünïcode")]);
    const capabilities = { incoming: ["kdeconnect.ping", "kdeconnect.share.request"], outgoing: ["kdeconnect.ping", "kdeconnect.share.request"] };
    const [to_phone, to_laptop] = await Promise.all([
      bluetooth_handshake(a, { identity: laptop, capabilities, trusted_certificate: () => null, address: "AA:BB:CC:DD:EE:01" }),
      bluetooth_handshake(b, { identity: phone, capabilities, trusted_certificate: () => null, address: "AA:BB:CC:DD:EE:02" }),
    ]);
    expect(to_phone.identity.deviceName).toBe("Phone ünïcode");
    expect(to_laptop.identity.deviceId).toBe(laptop.device_id);
    expect(to_phone.priority).toBe(10);
    expect(to_phone.certificate).toBe(exact_pem(phone.certificate));

    const heard = new Promise<{ type: string; payload: Buffer | null }>((resolve) =>
      to_laptop.set_handlers({ on_packet: (packet, payload) => void (payload ? payload.open().then(collect).then((data) => resolve({ type: packet.type, payload: data })) : resolve({ type: packet.type, payload: null })), on_close: () => undefined }),
    );
    to_phone.set_handlers({ on_packet: () => undefined, on_close: () => undefined });
    const file = randomBytes(70_000);
    await to_phone.send({ id: 1, type: "kdeconnect.share.request", body: { filename: "file.bin" } }, { size: file.length, open: () => Readable.from([file]) });
    const got = await heard;
    expect(got.type).toBe("kdeconnect.share.request");
    expect(got.payload?.equals(file)).toBe(true);
  }, 15_000);

  test("refuses a device showing another certificate than it paired with", async () => {
    const [a, b] = pair();
    const [laptop, phone, other] = await Promise.all([identity("Laptop"), identity("Phone"), identity("Other")]);
    const capabilities = { incoming: [], outgoing: [] };
    const results = await Promise.allSettled([
      bluetooth_handshake(a, { identity: laptop, capabilities, trusted_certificate: () => other.certificate, address: "x" }),
      bluetooth_handshake(b, { identity: phone, capabilities, trusted_certificate: () => null, address: "y" }),
    ]);
    expect(results[0].status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason.message).toMatch(/different certificate/);
  });

  test("writes identities as ASCII and certificates exactly as Android reads them", () => {
    expect(ascii_line({ id: 1, type: "t", body: { name: "Café ☕" } })).toBe('{"id":1,"type":"t","body":{"name":"Caf\\u00e9 \\u2615"}}\n');
    const pem = exact_pem("-----BEGIN CERTIFICATE-----\r\nAAAA\r\nBBBB\r\n-----END CERTIFICATE-----");
    expect(pem).toBe("-----BEGIN CERTIFICATE-----\nAAAABBBB\n-----END CERTIFICATE-----\n");
    expect(certificate_of("AAAA")).toBe(pem.replace("AAAABBBB", "AAAA"));
    expect(certificate_of("")).toBeNull();
  });
});

// ── Backend ──────────────────────────────────────────────────────────────────

import { create_bluetooth_backend } from "../src/server/kdeconnect/bluetooth/backend.ts";
import { address_of, service_uuid, type BluezBus, type BluezDevice, type ProfileHandlers } from "../src/server/kdeconnect/bluetooth/bluez.ts";
import type { DeviceLink } from "../src/server/kdeconnect/link.ts";

// A BlueZ that connects a pretend phone: asked to connect, it hands over one end of a socket pair and the phone runs
// its multiplexer and handshake on the other.
function fake_bluez(phone: DeviceIdentity, options: { refuse?: string } = {}) {
  const device: BluezDevice = { path: "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF", address: "AA:BB:CC:DD:EE:FF", name: "Phone", paired: true, uuids: [service_uuid.toUpperCase()] };
  let handlers: ProfileHandlers | null = null;
  const phone_links: DeviceLink[] = [];
  let connects = 0;
  const bus: BluezBus = {
    async register_profile(given) {
      if (options.refuse) throw new Error(options.refuse);
      handlers = given;
    },
    devices: async () => [device, { ...device, path: "/org/bluez/hci0/dev_11_22_33_44_55_66", uuids: [] }],
    async connect_profile(path) {
      connects++;
      const [ours, theirs] = duplexPair();
      const mux = create_mux(theirs);
      muxes.push(mux);
      handlers!.connection(path, ours);
      phone_links.push(await bluetooth_handshake(mux, { identity: phone, capabilities: { incoming: ["kdeconnect.ping"], outgoing: ["kdeconnect.ping"] }, trusted_certificate: () => null, address: "00:00:00:00:00:01" }));
    },
    close: async () => undefined,
  };
  return { bus, phone_links, connects: () => connects, handlers: () => handlers };
}

describe("the Bluetooth backend", () => {
  test("registers, reaches a bonded device offering KDE Connect, and keeps to one connection a device", async () => {
    const [laptop, phone] = await Promise.all([identity("Laptop"), identity("Phone")]);
    const bluez = fake_bluez(phone);
    const links: DeviceLink[] = [];
    const backend = create_bluetooth_backend({ bus: async () => bluez.bus, identity: () => laptop, capabilities: () => ({ incoming: [], outgoing: [] }), trusted_certificate: () => null, is_connected: () => false, on_link: (link) => links.push(link), interval_ms: 60_000 });
    await backend.start();
    for (let tries = 0; tries < 100 && links.length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(links[0]?.identity.deviceId).toBe(phone.device_id);
    expect(links[0]?.address).toBe("AA:BB:CC:DD:EE:FF");
    expect(bluez.connects()).toBe(1);
    expect(backend.status()).toEqual({ state: "on", error: null, connections: 1 });
    // Already connected, so a second round asks for nothing, and a second socket for it is dropped.
    await backend.connect_now();
    expect(bluez.connects()).toBe(1);
    const [extra] = duplexPair();
    bluez.handlers()!.connection("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF", extra);
    await new Promise((resolve) => setImmediate(resolve));
    expect(extra.destroyed).toBe(true);
    await backend.stop();
    expect(backend.status().state).toBe("off");
    expect(address_of("/org/bluez/hci0/dev_01_23_45_67_89_AB")).toBe("01:23:45:67:89:AB");
  });

  test("waits, saying why, while another app holds the profile", async () => {
    const [laptop, phone] = await Promise.all([identity("Laptop"), identity("Phone")]);
    const logged: string[] = [];
    const backend = create_bluetooth_backend({ bus: async () => fake_bluez(phone, { refuse: "org.bluez.Error.NotPermitted: UUID already registered" }).bus, identity: () => laptop, capabilities: () => ({ incoming: [], outgoing: [] }), trusted_certificate: () => null, is_connected: () => false, on_link: () => undefined, interval_ms: 60_000, log: (message) => logged.push(message) });
    await backend.start();
    await backend.connect_now();
    expect(backend.status()).toMatchObject({ state: "waiting", error: expect.stringContaining("already registered") });
    // Said once, not every round.
    expect(logged).toHaveLength(1);
    await backend.stop();
  });
});

// ── Control ──────────────────────────────────────────────────────────────────

describe("Bluetooth in the control core", () => {
  test("a phone reached over Bluetooth pairs, shows on This device, and a LAN link wins over it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const { open_store } = await import("../src/shared/store.ts");
    const { start_control } = await import("../src/server/control.ts");
    const { sample_computer } = await import("../src/server/system/sample.ts");
    const { bluetooth_text } = await import("../src/web/devices/DevicesView.tsx");
    const folder = mkdtempSync(join(tmpdir(), "x-control-bt-"));
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const phone = await identity("Phone");
    const bluez = fake_bluez(phone);
    const control = await start_control({
      database: () => database,
      identity_file: join(folder, "identity.json"),
      downloads_folder: join(folder, "Downloads"),
      mounts_folder: join(folder, "mounts"),
      system: sample_computer(),
      notify: () => {},
      withdraw: () => {},
      on_change: () => {},
      network: { discovery: false, bluetooth: true, allow_loopback: true, tcp_ports: { lowest: 42941, highest: 42943 }, payload_ports: { lowest: 42944, highest: 42950 } },
      bluez: async () => bluez.bus,
      log: () => {},
    });
    try {
      for (let tries = 0; tries < 200 && !control.devices.is_connected(phone.device_id); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(control.devices.is_connected(phone.device_id)).toBe(true);
      const this_device = await control.methods.get_this_device();
      expect(bluetooth_text(this_device.bluetooth)).toBe("On, for bonded devices");

      // The phone accepts the request it hears over Bluetooth.
      const phone_link = bluez.phone_links[0]!;
      phone_link.set_handlers({
        on_packet: (packet) => void (packet.type === "kdeconnect.pair" && packet.body.pair === true ? phone_link.send({ id: 2, type: "kdeconnect.pair", body: { pair: true } }) : undefined),
        on_close: () => undefined,
      });
      await control.methods.pair_device(phone.device_id);
      for (let tries = 0; tries < 100 && (await control.methods.get_device(phone.device_id)).pair_state !== "paired"; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await control.methods.get_device(phone.device_id)).pair_state).toBe("paired");
      expect(database.prepare("SELECT certificate FROM paired_devices").get()).toEqual({ certificate: exact_pem(phone.certificate) });

      // A LAN link takes over from Bluetooth, and Bluetooth does not take it back.
      const fake_link = (priority: number): DeviceLink & { closed: boolean } => {
        const link = { identity: bluez.phone_links[0]!.identity, certificate: exact_pem(phone.certificate), address: priority === 20 ? "10.0.0.2" : "AA:BB", priority, closed: false, is_open: () => !link.closed, send: async () => undefined, close: () => void (link.closed = true), set_handlers: () => undefined };
        link.identity = { ...link.identity, deviceId: phone.device_id };
        return link;
      };
      const lan = fake_link(20);
      control.devices.attach(lan);
      expect((await control.methods.get_device(phone.device_id)).address).toBe("10.0.0.2");
      const late_bluetooth = fake_link(10);
      control.devices.attach(late_bluetooth);
      expect(late_bluetooth.closed).toBe(true);
      expect(lan.closed).toBe(false);
    } finally {
      await control.stop();
      rmSync(folder, { recursive: true, force: true });
    }
  }, 20_000);
});
