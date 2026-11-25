// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261125075020_start",
    "statements": [
      "CREATE TABLE `commands` (\n\t`id` text PRIMARY KEY,\n\t`name` text NOT NULL,\n\t`command` text NOT NULL,\n\t`position` integer DEFAULT 0 NOT NULL\n);"
    ]
  }
];
