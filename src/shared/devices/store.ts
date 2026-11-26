// The paired devices a daemon keeps, each with the certificate it must show again, and what plugins keep of them while
// they are away. The tables never sync, since each daemon pairs on its own, and the page reaches devices through the
// daemon's device calls rather than this store.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, drizzle_of, eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature } from "../feature.ts";
import { migrations } from "./migrations/index.ts";
import type { PairedDevice, PairedStore } from "./model.ts";
import { device_states, paired_devices } from "./schema.ts";

// ── Store ────────────────────────────────────────────────────────────────────

export const devices_feature = define_feature({
  id: "devices",
  migrations: migrations.map((migration) => migration.statements),
  tables: [],
  methods: {},
  api: {},
});

// The paired devices on the database given, read afresh on every call.
export function paired_store(database: () => SqlDatabase): PairedStore {
  const rows = () => drizzle_of(database());
  return {
    list: () => rows().select().from(paired_devices).all() as PairedDevice[],
    get: (id) => (rows().select().from(paired_devices).where(eq(paired_devices.id, id)).get() as PairedDevice | undefined) ?? null,
    save: (device) => void rows().insert(paired_devices).values(device).onConflictDoUpdate({ target: paired_devices.id, set: device }).run(),
    remove: (id) => {
      rows().delete(device_states).where(eq(device_states.device_id, id)).run();
      rows().delete(paired_devices).where(eq(paired_devices.id, id)).run();
    },
    states: (id) => Object.fromEntries(rows().select().from(device_states).where(eq(device_states.device_id, id)).all().map((row) => [row.plugin_id, JSON.parse(row.state) as unknown])),
    save_state: (id, plugin_id, state) => {
      if (state === null || state === undefined) return void rows().delete(device_states).where(and(eq(device_states.device_id, id), eq(device_states.plugin_id, plugin_id))).run();
      const row = { device_id: id, plugin_id, state: JSON.stringify(state), updated_at: new Date().toISOString() };
      rows().insert(device_states).values(row).onConflictDoUpdate({ target: [device_states.device_id, device_states.plugin_id], set: row }).run();
    },
  };
}
