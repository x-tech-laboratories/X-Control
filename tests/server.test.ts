import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FastifyInstance } from "fastify";
import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { open_store } from "../src/shared/store.ts";
import { build_app } from "../src/server/app.ts";
import { start_control, type Control } from "../src/server/control.ts";
import { sample_computer } from "../src/server/system/sample.ts";

let app: FastifyInstance;
let control: Control;
let folder: string;
let cookie = "";

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "x-control-server-"));
  const database = new DatabaseSync(":memory:");
  open_store(database);
  control = await start_control({
    database: () => database,
    identity_file: join(folder, "identity.json"),
    downloads_folder: join(folder, "Downloads"),
    system: sample_computer(),
    notify: () => {},
    withdraw: () => {},
    on_change: () => {},
    network: { discovery: false, tcp_ports: { lowest: 44716, highest: 44730 } },
    defaults: { name: "Server" },
    log: () => {},
  });
  const backups = { list_backups: async () => [], create_backup: async () => "", restore_backup: async () => {}, remove_backup: async () => {}, get_backup_schedule: () => ({ automatic: true, to_keep: 14 }), set_backup_schedule: () => {} };
  app = await build_app({ database, control, declared: new Map([["admin", await hash_password("secret words")]]), web_folder: join(folder, "web"), backups: backups as never });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "secret words" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

afterAll(async () => {
  await app.close();
  await control.stop();
  rmSync(folder, { recursive: true, force: true });
});

describe("the server", () => {
  test("asks for a sign-in before any call", async () => {
    const response = await app.inject({ method: "POST", url: "/api/call/list_devices", payload: [] });
    expect(response.statusCode).toBe(401);
  });

  test("answers calls in order or by name", async () => {
    const by_list = await app.inject({ method: "POST", url: "/api/call/save_command", headers: { cookie }, payload: [{ name: "Lock", command: "loginctl lock-session" }] });
    expect(by_list.statusCode).toBe(200);
    const by_name = await app.inject({ method: "POST", url: "/api/call/get_command", headers: { cookie }, payload: { id: JSON.parse(by_list.body) } });
    expect(JSON.parse(by_name.body).name).toBe("Lock");
  });

  test("tells about this device and lists none other yet", async () => {
    const device = await app.inject({ method: "POST", url: "/api/call/get_this_device", headers: { cookie }, payload: [] });
    expect(JSON.parse(device.body)).toMatchObject({ name: "Server", type: "desktop", discovery: false });
    const devices = await app.inject({ method: "POST", url: "/api/call/list_devices", headers: { cookie }, payload: [] });
    expect(JSON.parse(devices.body)).toEqual([]);
  });

  test("describes every call in its OpenAPI document", async () => {
    const response = await app.inject({ method: "GET", url: "/api/openapi.json", headers: { cookie } });
    const paths = Object.keys((JSON.parse(response.body) as { paths: Record<string, unknown> }).paths);
    for (const method of ["list_devices", "run_device_action", "pair_device", "list_commands", "export_settings", "restore_version"]) expect(paths).toContain(`/api/call/${method}`);
  });

  test("refuses a call it does not know", async () => {
    const response = await app.inject({ method: "POST", url: "/api/call/drop_everything", headers: { cookie }, payload: [] });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
