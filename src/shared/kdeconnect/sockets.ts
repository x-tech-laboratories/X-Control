// The sockets KDE Connect's network side needs, as an interface: Node answers it on a computer and X-Libs'
// phone_sockets in the phone app's service, so the handshake, links and payloads are written once.
// A TCP stream reads nothing until asked, so TLS can follow the plain identity line in either role.

// ── Streams ──────────────────────────────────────────────────────────────────

export interface TlsOptions {
  // The TLS role, which need not match who connected; as a server it asks the peer for its certificate.
  role: "client" | "server";
  certificate: string;
  key: string;
}

export interface NetStream {
  remote_address: string;
  // Reads one line without its newline, refusing one longer than `most_bytes`.
  read_line(most_bytes: number): Promise<string>;
  // Starts TLS, letting any peer through and handing back its certificate as PEM for the caller to check.
  start_tls(options: TlsOptions): Promise<{ peer_certificate: string | null }>;
  // Hands over every byte from here on; `on_end` is called once, with null when the stream ended normally.
  start_reading(on_data: (bytes: Uint8Array) => void, on_end: (error: Error | null) => void): void;
  pause(): void;
  resume(): void;
  // Settles once the bytes are handed to the network.
  write(bytes: Uint8Array): Promise<void>;
  // Closes the stream once what was written has gone out.
  end(): Promise<void>;
  destroy(): void;
}

// ── Servers ──────────────────────────────────────────────────────────────────

export interface NetServer {
  port: number;
  close(): void;
}

export interface NetUdp {
  port: number;
  send(bytes: Uint8Array, address: string, port: number): Promise<void>;
  close(): void;
}

export interface NetSockets {
  // Listens on a port, 0 for any; fails when the port is taken.
  tcp_listen(port: number, on_connection: (stream: NetStream) => void): Promise<NetServer>;
  tcp_connect(host: string, port: number): Promise<NetStream>;
  // A UDP socket on a port, 0 for any, that may send broadcasts.
  udp_open(port: number, on_message: (bytes: Uint8Array, address: string) => void, on_error?: (error: Error) => void): Promise<NetUdp>;
  // Every network's broadcast address, and 255.255.255.255.
  broadcast_addresses(): Promise<string[]>;
}

// ── Reading as a stream ──────────────────────────────────────────────────────

// How many chunks wait for a slow reader before the stream is paused.
const most_waiting_chunks = 16;

// A stream's bytes from here on as an async iterable, pausing the stream while the reader falls behind.
export function bytes_of(stream: NetStream): AsyncIterable<Uint8Array> {
  const waiting: Uint8Array[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let paused = false;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  stream.start_reading(
    (bytes) => {
      waiting.push(bytes);
      if (!paused && waiting.length >= most_waiting_chunks) {
        paused = true;
        stream.pause();
      }
      nudge();
    },
    (error) => {
      ended = true;
      failure = error;
      nudge();
    },
  );
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const next = waiting.shift();
          if (next) {
            if (paused && waiting.length < most_waiting_chunks / 2) {
              paused = false;
              stream.resume();
            }
            yield next;
            continue;
          }
          if (ended) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        // A reader that stops early closes the stream.
        if (!ended) stream.destroy();
      }
    },
  };
}
