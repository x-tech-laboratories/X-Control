// KDE Connect on the local network of a computer: the shared handshake in src/shared/kdeconnect/lan.ts over Node's sockets.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_lan, type LanBackend, type LanOptions as SharedLanOptions } from "../../shared/kdeconnect/lan.ts";
import { node_sockets } from "./node_sockets.ts";

// ── Backend ──────────────────────────────────────────────────────────────────

export type { LanBackend };
export type LanOptions = Omit<SharedLanOptions, "sockets"> & Partial<Pick<SharedLanOptions, "sockets">>;

export function create_lan_backend(options: LanOptions): LanBackend {
  return create_lan({ sockets: node_sockets(), ...options });
}
