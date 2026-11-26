// The sockets KDE Connect's network side runs over on a computer, answered by Node's net, tls and dgram.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createSocket } from "node:dgram";
import { connect as connect_tcp, createServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { connect as connect_tls, createSecureContext, TLSSocket } from "node:tls";

import type { NetSockets, NetStream, TlsOptions } from "../../shared/kdeconnect/sockets.ts";

// ── Streams ──────────────────────────────────────────────────────────────────

// Settles when TLS is up, and fails when the socket closes or errs first.
function secured(socket: TLSSocket, event: "secure" | "secureConnect"): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed during the handshake")));
  });
}

export function node_stream(plain: Socket): NetStream {
  let socket: Socket | TLSSocket = plain;
  // An error with no other listener would end the program; the reader learns of it as the end of the stream.
  const ignore = (): void => {};
  plain.on("error", ignore);

  return {
    remote_address: plain.remoteAddress ?? "",
    read_line(most_bytes) {
      return new Promise((resolve, reject) => {
        let held = Buffer.alloc(0);
        const done = (): void => {
          socket.off("data", on_data);
          socket.off("error", on_error);
          socket.off("close", on_close);
        };
        const on_data = (chunk: Buffer): void => {
          held = Buffer.concat([held, chunk]);
          const end = held.indexOf(10);
          if (end >= 0) {
            done();
            socket.pause();
            // What came after the line is put back for the next read.
            const rest = held.subarray(end + 1);
            if (rest.length > 0) socket.unshift(rest);
            resolve(held.subarray(0, end).toString("utf8"));
          } else if (held.length > most_bytes) {
            done();
            reject(new Error("the line is too long"));
          }
        };
        const on_error = (error: Error): void => (done(), reject(error));
        const on_close = (): void => (done(), reject(new Error("closed before a whole line")));
        socket.on("data", on_data);
        socket.once("error", on_error);
        socket.once("close", on_close);
      });
    },
    async start_tls({ role, certificate, key }: TlsOptions) {
      const context = createSecureContext({ cert: certificate, key });
      const secure =
        role === "server"
          ? new TLSSocket(socket as Socket, { isServer: true, secureContext: context, requestCert: true, rejectUnauthorized: false })
          : connect_tls({ socket: socket as Socket, secureContext: context, rejectUnauthorized: false, checkServerIdentity: () => undefined });
      secure.on("error", ignore);
      socket = secure;
      await secured(secure, role === "server" ? "secure" : "secureConnect");
      return { peer_certificate: secure.getPeerX509Certificate()?.toString() ?? null };
    },
    start_reading(on_data, on_end) {
      let ended = false;
      const end = (error: Error | null): void => {
        if (ended) return;
        ended = true;
        on_end(error);
      };
      socket.on("data", (chunk: Buffer) => on_data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      socket.once("error", (error) => end(error));
      socket.once("close", () => end(null));
      socket.setKeepAlive(true, 10_000);
      socket.resume();
    },
    pause: () => void socket.pause(),
    resume: () => void socket.resume(),
    write: (bytes) => new Promise((resolve, reject) => socket.write(bytes, (error) => (error ? reject(error) : resolve()))),
    end: () =>
      new Promise((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
      }),
    destroy: () => void socket.destroy(),
  };
}

// ── Sockets ──────────────────────────────────────────────────────────────────

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

export function node_sockets(): NetSockets {
  return {
    tcp_listen: (port, on_connection) =>
      new Promise((resolve, reject) => {
        const server = createServer((socket) => on_connection(node_stream(socket)));
        server.once("error", reject);
        server.listen(port, () => {
          server.off("error", reject);
          resolve({ port: (server.address() as { port: number }).port, close: () => void server.close() });
        });
      }),
    tcp_connect: (host, port) =>
      new Promise((resolve, reject) => {
        const socket = connect_tcp({ host, port }, () => {
          socket.off("error", reject);
          resolve(node_stream(socket));
        });
        socket.once("error", reject);
      }),
    udp_open: (port, on_message, on_error) =>
      new Promise((resolve, reject) => {
        const socket = createSocket({ type: "udp4", reuseAddr: true });
        socket.on("message", (message, sender) => on_message(new Uint8Array(message.buffer, message.byteOffset, message.byteLength), sender.address));
        socket.once("error", reject);
        socket.bind(port, () => {
          socket.off("error", reject);
          socket.on("error", (error) => on_error?.(error));
          socket.setBroadcast(true);
          resolve({
            port: socket.address().port,
            send: (bytes, address, to_port) => new Promise((done, fail) => socket.send(bytes, to_port, address, (error) => (error ? fail(error) : done()))),
            close: () => socket.close(),
          });
        });
      }),
    broadcast_addresses: async () => every_broadcast_address(),
  };
}
