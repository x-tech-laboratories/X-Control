// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261125075020_start",
    "statements": [
      "CREATE TABLE `paired_devices` (\n\t`id` text PRIMARY KEY,\n\t`name` text NOT NULL,\n\t`type` text NOT NULL,\n\t`certificate` text NOT NULL,\n\t`paired_at` text NOT NULL,\n\t`last_address` text,\n\t`last_seen` text\n);"
    ]
  },
  {
    "name": "20261125235904_device_states",
    "statements": [
      "CREATE TABLE `device_states` (\n\t`device_id` text NOT NULL,\n\t`plugin_id` text NOT NULL,\n\t`state` text NOT NULL,\n\t`updated_at` text NOT NULL,\n\tCONSTRAINT `device_states_pk` PRIMARY KEY(`device_id`, `plugin_id`)\n);"
    ]
  }
];
