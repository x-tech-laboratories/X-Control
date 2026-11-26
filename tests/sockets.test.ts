import { describe, expect, test, vi } from "vitest";

import { common_name_of, same_certificate } from "../src/shared/kdeconnect/certificates.ts";
import { create_lan, type LanIdentity } from "../src/shared/kdeconnect/lan.ts";
import type { DeviceLink, IncomingPayload } from "../src/shared/kdeconnect/link.ts";
import { make_packet, type Packet } from "../src/shared/kdeconnect/packet.ts";
import { bytes_of, type NetSockets, type NetStream } from "../src/shared/kdeconnect/sockets.ts";
import { make_certificate } from "../src/server/kdeconnect/identity.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── An in-memory network ─────────────────────────────────────────────────────

// One end of an in-memory connection; TLS only swaps the two sides' certificates.
interface End extends NetStream {
  peer: End | null;
  take(bytes: Uint8Array): void;
  finish(): void;
  certificate: string | null;
  tls_waiters: (() => void)[];
}

function make_end(remote_address: string): End {
  let held = new Uint8Array(0);
  let reading: { on_data: (bytes: Uint8Array) => void; on_end: (error: Error | null) => void } | null = null;
  let closed = false;
  let paused = false;
  let line_waiter: (() => void) | null = null;
  const end: End = {
    peer: null,
    certificate: null,
    tls_waiters: [],
    remote_address,
    take(bytes) {
      if (reading && !paused) return queueMicrotask(() => reading?.on_data(bytes));
      const joined = new Uint8Array(held.length + bytes.length);
      joined.set(held);
      joined.set(bytes, held.length);
      held = joined;
      line_waiter?.();
    },
    finish() {
      if (closed) return;
      closed = true;
      line_waiter?.();
      queueMicrotask(() => reading?.on_end(null));
    },
    async read_line(most_bytes) {
      while (true) {
        const index = held.indexOf(10);
        if (index >= 0) {
          const line = decoder.decode(held.subarray(0, index));
          held = held.subarray(index + 1);
          return line;
        }
        if (held.length > most_bytes) throw new Error("the line is too long");
        if (closed) throw new Error("closed before a whole line");
        await new Promise<void>((resolve) => (line_waiter = resolve));
        line_waiter = null;
      }
    },
    async start_tls({ certificate }) {
      end.certificate = certificate;
      const peer = end.peer!;
      if (peer.certificate === null) await new Promise<void>((resolve) => peer.tls_waiters.push(resolve));
      for (const wake of end.tls_waiters.splice(0)) wake();
      return { peer_certificate: peer.certificate };
    },
    start_reading(on_data, on_end) {
      reading = { on_data, on_end };
      if (held.length > 0) {
        const first = held;
        held = new Uint8Array(0);
        queueMicrotask(() => on_data(first));
      }
      if (closed) queueMicrotask(() => on_end(null));
    },
    pause: () => void (paused = true),
    resume() {
      paused = false;
      if (held.length > 0 && reading) {
        const kept = held;
        held = new Uint8Array(0);
        reading.on_data(kept);
      }
    },
    write: async (bytes) => {
      if (closed) throw new Error("closed");
      end.peer?.take(bytes.slice());
    },
    end: async () => {
      end.peer?.finish();
      end.finish();
    },
    destroy() {
      end.peer?.finish();
      end.finish();
    },
  };
  return end;
}

function memory_network() {
  const listening = new Map<string, (stream: NetStream) => void>();
  const datagrams = new Map<string, { address: string; on_message: (bytes: Uint8Array, address: string) => void }>();
  const sockets = (address: string): NetSockets => ({
    async tcp_listen(port, on_connection) {
      const key = `${address}:${port}`;
      if (listening.has(key)) throw new Error("taken");
      listening.set(key, on_connection);
      return { port, close: () => void listening.delete(key) };
    },
    async tcp_connect(host, port) {
      const accept = listening.get(`${host}:${port}`);
      if (!accept) throw new Error("refused");
      const near = make_end(host);
      const far = make_end(address);
      near.peer = far;
      far.peer = near;
      accept(far);
      return near;
    },
    async udp_open(port, on_message) {
      datagrams.set(`${address}:${port}`, { address, on_message });
      return {
        port,
        async send(bytes, to, to_port) {
          for (const [key, entry] of datagrams) {
            if (entry.address === address) continue;
            if (to === "255.255.255.255" ? key.endsWith(`:${to_port}`) : key === `${to}:${to_port}`) entry.on_message(bytes, address);
          }
        },
        close: () => void datagrams.delete(`${address}:${port}`),
      };
    },
    broadcast_addresses: async () => ["255.255.255.255"],
  });
  return { sockets };
}

// ── Devices ──────────────────────────────────────────────────────────────────

async function device(id: string, name: string, type: LanIdentity["type"]): Promise<LanIdentity> {
  return { device_id: id, name, type, ...(await make_certificate(id)) };
}

const capabilities = () => ({ incoming: ["kdeconnect.ping", "kdeconnect.share.request"], outgoing: ["kdeconnect.ping", "kdeconnect.share.request"] });

describe("certificates read without Node", () => {
  test("give the common name and tell the same certificate from another", async () => {
    const one = await make_certificate("aaaa1111bbbb2222cccc3333dddd4444");
    const two = await make_certificate("aaaa1111bbbb2222cccc3333dddd4444");
    expect(common_name_of(one.certificate)).toBe("aaaa1111bbbb2222cccc3333dddd4444");
    expect(same_certificate(one.certificate, one.certificate)).toBe(true);
    expect(same_certificate(one.certificate, two.certificate)).toBe(false);
  });
});

describe("the shared LAN code over other sockets", () => {
  test("finds a device by broadcast, shakes hands, and carries packets and a payload", async () => {
    const network = memory_network();
    const computer = await device("c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0", "Computer", "desktop");
    const phone = await device("f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", "Phone", "phone");
    const links: { computer?: DeviceLink; phone?: DeviceLink } = {};
    const both = new Promise<void>((resolve) => {
      const check = () => links.computer && links.phone && resolve();
      const lan_of = (identity: LanIdentity, address: string, side: "computer" | "phone") =>
        create_lan({
          sockets: network.sockets(address),
          identity: () => identity,
          capabilities,
          trusted_certificate: () => null,
          on_link: (link) => ((links[side] = link), check()),
          tcp_ports: { lowest: 41716, highest: 41720 },
          payload_ports: { lowest: 41730, highest: 41740 },
          listen_port: 41716,
          announce_port: 41716,
        });
      void lan_of(computer, "10.0.0.1", "computer").start().then(() => lan_of(phone, "10.0.0.2", "phone").start());
    });
    await both;
    expect(links.computer!.identity.deviceName).toBe("Phone");
    expect(links.phone!.identity.deviceName).toBe("Computer");
    expect(links.phone!.address).toBe("10.0.0.1");

    const heard = new Promise<{ packet: Packet; payload: IncomingPayload | null }>((resolve) =>
      links.computer!.set_handlers({ on_packet: (packet, payload) => resolve({ packet, payload }), on_close: () => undefined }),
    );
    links.phone!.set_handlers({ on_packet: () => undefined, on_close: () => undefined });
    const content = encoder.encode("a photo's bytes ".repeat(500));
    const sending = links.phone!.send(make_packet("kdeconnect.share.request", { filename: "photo.jpg" }), { size: content.length, open: () => (async function* () {
      yield content.subarray(0, 3000);
      yield content.subarray(3000);
    })() });
    const { packet, payload } = await heard;
    expect(packet.body.filename).toBe("photo.jpg");
    expect(payload?.size).toBe(content.length);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await payload!.open()) chunks.push(chunk);
    await sending;
    expect(decoder.decode(Buffer.concat(chunks))).toBe(decoder.decode(content));
  });

  test("refuses a paired device that shows another certificate", async () => {
    const network = memory_network();
    const computer = await device("c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1", "Computer", "desktop");
    const phone = await device("f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1", "Phone", "phone");
    const impostor = await make_certificate(phone.device_id);
    const warnings: string[] = [];
    const on_link = vi.fn();
    const computer_lan = create_lan({
      sockets: network.sockets("10.0.0.1"),
      identity: () => computer,
      capabilities,
      trusted_certificate: () => impostor.certificate,
      on_link,
      tcp_ports: { lowest: 41716, highest: 41716 },
      discovery: false,
      on_warning: (message) => warnings.push(message),
    });
    const phone_lan = create_lan({ sockets: network.sockets("10.0.0.2"), identity: () => phone, capabilities, trusted_certificate: () => null, on_link: () => undefined, tcp_ports: { lowest: 41716, highest: 41716 }, discovery: false });
    await computer_lan.start();
    await phone_lan.start();
    await expect(computer_lan.connect("10.0.0.2", 41716)).rejects.toThrow("different certificate");
    expect(on_link).not.toHaveBeenCalled();
    await computer_lan.stop();
    await phone_lan.stop();
  });
});

describe("a stream's bytes", () => {
  test("pause the stream while the reader falls behind, and end with its error", async () => {
    const stream = make_end("10.0.0.3");
    const pause = vi.spyOn(stream, "pause");
    const resume = vi.spyOn(stream, "resume");
    let push: (bytes: Uint8Array) => void = () => {};
    let finish: (error: Error | null) => void = () => {};
    stream.start_reading = (on_data, on_end) => ((push = on_data), (finish = on_end));
    const bytes = bytes_of(stream);
    for (let index = 0; index < 20; index++) push(Uint8Array.of(index));
    expect(pause).toHaveBeenCalledTimes(1);
    finish(new Error("reset"));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const chunk of bytes) seen.push(chunk[0]!);
      })(),
    ).rejects.toThrow("reset");
    expect(seen).toHaveLength(20);
    expect(resume).toHaveBeenCalled();
  });

  test("close the stream when the reader stops early", async () => {
    const stream = make_end("10.0.0.3");
    const destroy = vi.spyOn(stream, "destroy");
    let push: (bytes: Uint8Array) => void = () => {};
    stream.start_reading = (on_data) => void (push = on_data);
    const bytes = bytes_of(stream);
    push(Uint8Array.of(1));
    for await (const _chunk of bytes) break;
    expect(destroy).toHaveBeenCalled();
  });
});
