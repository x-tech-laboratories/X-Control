import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { read_config } from "../src/server/config.ts";

describe("the server config", () => {
  test("names where paired daemons reach the server's sync, and none when the config leaves it out", () => {
    const folder = "/tmp/x-control-config";
    expect(read_config({ database: join(folder, "control.db"), sync_address: "https://control.example.org/api/" }).sync_address).toBe("https://control.example.org/api/");
    expect(read_config({ database: join(folder, "control.db") }).sync_address).toBeNull();
    expect(read_config({ database: join(folder, "control.db"), sync_address: "" }).sync_address).toBeNull();
  });

  test("puts every folder beside the database unless the config names one, and refuses a config without a database", () => {
    const config = read_config({ database: "/tmp/x-control-config/control.db", backups_folder: "/srv/backups" });
    expect(config).toMatchObject({ backups_folder: "/srv/backups", plugins_folder: "/tmp/x-control-config/plugins", identity_file: "/tmp/x-control-config/identity.json" });
    expect(() => read_config({})).toThrow("the config must name the database");
  });
});
