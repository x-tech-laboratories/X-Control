// The calls on this computer's System Bridge server: how it stands, the keys its clients sign in with, and pairing
// codes a client such as Home Assistant trades for a key.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { id_of, text } from "../api_schemas.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface SystemBridgeStatus {
  state: "off" | "listening" | "failed";
  port: number | null;
  // Clients signed in now, such as Home Assistant.
  clients: number;
  // What clients know this computer by; Home Assistant keys its entities by it.
  uuid: string;
  error: string | null;
}

export interface SystemBridgeKey {
  id: string;
  name: string;
  kind: string;
  created_at: string;
}

// ── Calls ────────────────────────────────────────────────────────────────────

export interface SystemBridgeMethods {
  get_system_bridge_status(): Promise<SystemBridgeStatus>;
  list_system_bridge_keys(): Promise<SystemBridgeKey[]>;
  create_system_bridge_key(name: string): Promise<{ key: string; view: SystemBridgeKey }>;
  remove_system_bridge_key(id: string): Promise<void>;
  create_system_bridge_pairing_code(): Promise<{ code: string; expires_at: string }>;
}

export const system_bridge_method_names = ["get_system_bridge_status", "list_system_bridge_keys", "create_system_bridge_key", "remove_system_bridge_key", "create_system_bridge_pairing_code"] as const satisfies readonly (keyof SystemBridgeMethods)[];

export const system_bridge_api: ApiSpec<SystemBridgeMethods> = {
  get_system_bridge_status: { description: "Whether this computer's System Bridge server listens, on which port, how many clients are signed in, and the uuid clients know it by.", params: [] },
  list_system_bridge_keys: { description: "The keys System Bridge clients sign in with, by name and when each was made; the keys themselves are never shown again.", params: [] },
  create_system_bridge_key: {
    description: "Makes a key a System Bridge client, such as Home Assistant, signs in with. Answers the key once; only its hash is kept.",
    params: [{ name: "name", schema: text("Who the key is for, such as Home Assistant.") }],
  },
  remove_system_bridge_key: { description: "Removes a key; the client using it can no longer sign in.", params: [{ name: "id", schema: id_of("key") }], destructive: true },
  create_system_bridge_pairing_code: { description: "Makes a code, good for ten minutes and once, that a System Bridge client such as Home Assistant trades for a key of its own.", params: [] },
};
