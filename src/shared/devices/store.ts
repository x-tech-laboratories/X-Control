// The paired devices a daemon keeps, each with the certificate it must show again. The table never syncs, since each
// daemon pairs on its own, and the page reaches devices through the daemon's device calls rather than this store.

// ── Imports ──────────────────────────────────────────────────────────────────

import { drizzle_of, eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature } from "../feature.ts";
import { migrations } from "./migrations/index.ts";
import type { PairedDevice, PairedStore } from "./model.ts";
import { paired_devices } from "./schema.ts";

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
    remove: (id) => void rows().delete(paired_devices).where(eq(paired_devices.id, id)).run(),
  };
}
