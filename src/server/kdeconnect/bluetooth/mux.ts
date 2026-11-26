// KDE Connect's multiplexer over a Bluetooth connection: frames of a type, a length and a channel UUID carry several
// byte streams on one RFCOMM socket, each written only as far as the other side has granted, at most 4096 bytes at
// a time, as KDE Connect, its Android app and Valent all do. The default channel carries the packets; each payload
// gets a channel of its own.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";

// ── Wire format ──────────────────────────────────────────────────────────────

export const default_channel = "a0d0aaf4-1072-4d81-aa35-902a954b1266";

export const message = { protocol_version: 0, open_channel: 1, close_channel: 2, read: 3, write: 4 } as const;

// Every implementation buffers 4096 bytes a channel; Android's writer breaks if granted more than that.
export const buffer_size = 4096;

const header_size = 19;
const empty_uuid = "00000000-0000-0000-0000-000000000000";

export function uuid_bytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

// A channel's UUID as Valent compares them: lowercase, with dashes.
export function uuid_text(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function frame(type: number, channel: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(header_size);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(data.length, 1);
  uuid_bytes(channel).copy(header, 3);
  return Buffer.concat([header, data]);
}

// The first message each side sends: protocol versions 1 to 1, with exactly four bytes, since Valent reads no more.
export function version_frame(): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(1, 0);
  data.writeUInt16BE(1, 2);
  return frame(message.protocol_version, empty_uuid, data);
}

// ── Channels ─────────────────────────────────────────────────────────────────

export class MuxChannel extends Duplex {
  readonly uuid: string;
  // Granted to the other side and not yet received.
  private outstanding = 0;
  // Granted by the other side and not yet sent.
  private free_write = 0;
  private waiting_write: (() => void) | null = null;
  private remote_closed = false;
  private sent_close = false;
  private grant_queued = false;
  private readonly mux: Mux;

  constructor(mux: Mux, uuid: string) {
    super({ highWaterMark: buffer_size });
    this.mux = mux;
    this.uuid = uuid;
  }

  // Grants the other side as much as fits beside what is buffered and already granted, in steps of half the buffer
  // once data flows, so grants stay few.
  grant(at_start = false): void {
    if (this.remote_closed || this.mux.is_closed()) return;
    const room = buffer_size - this.outstanding - this.readableLength;
    if (room <= 0 || (!at_start && room < buffer_size / 2)) return;
    this.outstanding += room;
    const data = Buffer.alloc(2);
    data.writeUInt16BE(room, 0);
    this.mux.send(frame(message.read, this.uuid, data));
  }

  // Bytes the other side wrote; more than it was granted breaks the protocol and ends the connection.
  received(data: Buffer): void {
    if (data.length > this.outstanding) return this.mux.fail(new Error(`${data.length} bytes on channel ${this.uuid} beyond the ${this.outstanding} granted`));
    this.outstanding -= data.length;
    this.push(data);
    this.grant_soon();
  }

  // Grants once the data just handed on has left the buffer: Node asks for more before it takes the data out.
  grant_soon(): void {
    if (this.grant_queued) return;
    this.grant_queued = true;
    process.nextTick(() => {
      this.grant_queued = false;
      this.grant();
    });
  }

  credited(amount: number): void {
    this.free_write += amount;
    const waiting = this.waiting_write;
    this.waiting_write = null;
    waiting?.();
  }

  remote_close(): void {
    this.remote_closed = true;
    this.push(null);
    this.credited(0);
  }

  override _read(): void {
    this.grant_soon();
  }

  override async _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): Promise<void> {
    try {
      let rest = chunk;
      while (rest.length > 0) {
        if (this.mux.is_closed() || this.remote_closed) throw new Error("the Bluetooth channel closed");
        if (this.free_write === 0) {
          await new Promise<void>((resolve) => (this.waiting_write = resolve));
          continue;
        }
        const size = Math.min(rest.length, this.free_write, buffer_size);
        this.free_write -= size;
        this.mux.send(frame(message.write, this.uuid, rest.subarray(0, size)));
        rest = rest.subarray(size);
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  // Everything written went out, so the other side hears the channel is done; that ends a payload.
  override _final(done: (error?: Error | null) => void): void {
    this.send_close();
    done();
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.send_close();
    this.mux.forget(this.uuid);
    done(error);
  }

  private send_close(): void {
    if (this.sent_close || this.uuid === default_channel) return;
    this.sent_close = true;
    if (!this.mux.is_closed()) this.mux.send(frame(message.close_channel, this.uuid));
  }
}

// ── Multiplexer ──────────────────────────────────────────────────────────────

export interface Mux {
  // The channel the packets travel on, open from the start.
  readonly packets: MuxChannel;
  // Opens a channel for a payload; the other side hears of it before anything is written on it.
  open_channel(): MuxChannel;
  // A channel the other side opened, by its UUID, once it has.
  channel(uuid: string): MuxChannel | undefined;
  // Waits up to the time given for the other side to open a channel.
  wait_for_channel(uuid: string, timeout_ms?: number): Promise<MuxChannel>;
  send(data: Buffer): void;
  fail(error: Error): void;
  forget(uuid: string): void;
  is_closed(): boolean;
  close(): void;
  // Resolves when the connection ends, for any reason.
  readonly closed: Promise<void>;
}

export function create_mux(socket: Duplex, log: (message: string) => void = () => {}): Mux {
  const channels = new Map<string, MuxChannel>();
  const waiting = new Map<string, (channel: MuxChannel) => void>();
  let pending: Buffer = Buffer.alloc(0);
  let got_version = false;
  let closed = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));

  const mux: Mux = {
    packets: null as unknown as MuxChannel,
    open_channel() {
      const channel = new MuxChannel(mux, randomUUID());
      channels.set(channel.uuid, channel);
      mux.send(frame(message.open_channel, channel.uuid));
      channel.grant(true);
      return channel;
    },
    channel: (uuid) => channels.get(uuid.toLowerCase()),
    wait_for_channel(uuid, timeout_ms = 10_000) {
      const found = channels.get(uuid.toLowerCase());
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(uuid.toLowerCase());
          reject(new Error("the device never opened the payload's channel"));
        }, timeout_ms);
        waiting.set(uuid.toLowerCase(), (channel) => {
          clearTimeout(timer);
          resolve(channel);
        });
      });
    },
    send(data) {
      if (!closed) socket.write(data);
    },
    fail(error) {
      log(`Bluetooth: ${error.message}`);
      mux.close();
    },
    forget: (uuid) => void (uuid !== default_channel && channels.delete(uuid)),
    is_closed: () => closed,
    close() {
      if (closed) return;
      closed = true;
      for (const channel of channels.values()) channel.remote_close();
      channels.clear();
      socket.destroy();
      finish();
    },
    closed: done,
  };
  const packets = new MuxChannel(mux, default_channel);
  (mux as { packets: MuxChannel }).packets = packets;
  channels.set(default_channel, packets);

  function handle(type: number, uuid: string, data: Buffer): void {
    if (!got_version) {
      if (type !== message.protocol_version) return mux.fail(new Error("the device did not start with its protocol version"));
      if (data.length < 4) return mux.fail(new Error("the device's protocol version is too short"));
      const lowest = data.readUInt16BE(0);
      const highest = data.readUInt16BE(2);
      if (lowest > 1 || highest < 1) return mux.fail(new Error(`the device speaks multiplexer versions ${lowest} to ${highest}, not 1`));
      got_version = true;
      return;
    }
    const channel = channels.get(uuid);
    if (type === message.open_channel) {
      if (channel) return;
      const opened = new MuxChannel(mux, uuid);
      channels.set(uuid, opened);
      // Granted at once, since Android grants nothing until it reads and waits for the other side to.
      opened.grant(true);
      waiting.get(uuid)?.(opened);
      waiting.delete(uuid);
      return;
    }
    // Messages for channels never opened are ignored, as KDE Connect and Android do.
    if (!channel) return;
    if (type === message.close_channel) {
      channels.delete(uuid);
      if (uuid !== default_channel) channel.remote_close();
    } else if (type === message.read) {
      if (data.length >= 2) channel.credited(data.readUInt16BE(0));
    } else if (type === message.write) {
      channel.received(data);
    }
    // Any other type is skipped, its length already consumed.
  }

  socket.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (!closed && pending.length >= header_size) {
      const length = pending.readUInt16BE(1);
      if (pending.length < header_size + length) break;
      const type = pending.readUInt8(0);
      const uuid = uuid_text(pending.subarray(3, header_size));
      const data = pending.subarray(header_size, header_size + length);
      pending = pending.subarray(header_size + length);
      handle(type, uuid, Buffer.from(data));
    }
  });
  socket.on("error", (error) => mux.fail(error));
  socket.on("close", () => mux.close());
  socket.on("end", () => mux.close());

  // Version first, then a grant on the packet channel, as Valent and KDE Connect send them.
  socket.write(version_frame());
  packets.grant(true);
  return mux;
}
