// The phone's page: a window onto an X-Control daemon on another computer, chosen under Settings → Connections and
// signed in once as this phone. Every call goes there with the phone's token, and its change events keep the page
// current. A phone cannot keep a daemon running, so it has none of its own.

// ── Imports ──────────────────────────────────────────────────────────────────

import { App } from "@capacitor/app";
import type { BackupClient } from "@x-tech-laboratories/x-libs/backup_protocol";
import { create_connections } from "@x-tech-laboratories/x-libs/connections";
import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { phone_certificates } from "@x-tech-laboratories/x-libs/phone_certificates";
import { local_connection_storage } from "@x-tech-laboratories/x-libs/web/connection_storage";
import { LoginNeeded } from "@x-tech-laboratories/x-libs/web/states";

import type { ControlMethods, PageApi } from "../../shared/page_api.ts";

// ── Remote calls ─────────────────────────────────────────────────────────────

interface RemoteDaemon {
  address: string;
  token: string;
}

const no_daemon_text = "No daemon is chosen yet. Add one under Settings → Connections.";
const retry_in_milliseconds = 5000;

async function call_remote(daemon: RemoteDaemon | null, path: string, args: unknown[], client_id: string): Promise<unknown> {
  if (daemon === null) throw new Error(no_daemon_text);
  let response: Response;
  try {
    response = await fetch(`${daemon.address}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${daemon.token}`, "x-client-id": client_id },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error(`The daemon at ${daemon.address} did not answer.`);
  }
  const text = await response.text();
  if (response.status === 401) throw new LoginNeeded("This phone's sign-in was refused; add the daemon again under Settings → Connections.");
  if (!response.ok) throw new Error(text || `The daemon answered ${response.status}.`);
  return text === "" ? undefined : JSON.parse(text);
}

function remote_table<Methods extends Record<keyof Methods, (...args: never[]) => unknown>>(daemon: () => RemoteDaemon | null, prefix: string, client_id: () => string): Client<Methods> {
  return new Proxy({} as Client<Methods>, {
    get: (_target, name) => (typeof name === "string" && name !== "then" ? (...args: unknown[]) => call_remote(daemon(), `${prefix}${name}`, args, client_id()) : undefined),
  });
}

// Follows the daemon's change events with the token, reconnecting whenever the stream ends.
function follow_remote(daemon: () => RemoteDaemon | null, on_event: (event: string, data: string) => void): void {
  async function read(): Promise<void> {
    const current = daemon();
    if (current === null) return;
    const response = await fetch(`${current.address}/api/events`, { headers: { accept: "text/event-stream", authorization: `Bearer ${current.token}` } });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event:\s*(.*)$/m.exec(block)?.[1] ?? "message";
        const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((match) => match[1]).join("\n");
        on_event(event, data);
        cut = buffer.indexOf("\n\n");
      }
    }
  }
  const open = (): void => void read().catch(() => undefined).finally(() => setTimeout(open, retry_in_milliseconds));
  open();
}

// ── Api ──────────────────────────────────────────────────────────────────────

export function android_api(): PageApi {
  const connections = create_connections({ storage: local_connection_storage("x-control-connections"), offers_local: false, device_name: "X-Control on Android" });
  const daemon = (): RemoteDaemon | null => {
    const current = connections.current();
    return current?.kind === "remote" ? { address: current.address, token: current.token } : null;
  };
  // Another daemon chosen, or one added first: the page starts again on it.
  connections.subscribe(() => location.reload());

  let client_id = "";
  const listeners = new Set<() => void>();
  const announce = (): void => {
    for (const listener of listeners) listener();
  };
  follow_remote(daemon, (event, data) => {
    if (event === "hello") {
      client_id = data;
      announce();
    }
    if (event === "changed") announce();
  });
  // Back from the background, the page catches up on what it missed.
  void App.addListener("resume", announce);

  return {
    host: "android",
    calls: remote_table<ControlMethods>(daemon, "/api/call/", () => client_id),
    device: null,
    backups: remote_table<BackupClient>(daemon, "/api/backup/", () => client_id) as BackupClient,
    connections: connections.methods,
    certificates: phone_certificates(),
    on_change: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
