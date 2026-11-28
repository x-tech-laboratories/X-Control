import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FastifyInstance } from "fastify";
import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";
import { file_sync_storage } from "@x-tech-laboratories/x-libs/sync_file_storage";
import { decode_pairing_offer } from "@x-tech-laboratories/x-libs/sync_seal";
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
    mounts_folder: join(folder, "mounts"),
    system: sample_computer(),
    notify: () => {},
    withdraw: () => {},
    on_change: () => {},
    network: { discovery: false, tcp_ports: { lowest: 44716, highest: 44730 } },
    defaults: { name: "Server" },
    log: () => {},
  });
  const backups = { list_backups: async () => [], create_backup: async () => "", restore_backup: async () => {}, remove_backup: async () => {}, get_backup_schedule: () => ({ automatic: true, to_keep: 14 }), set_backup_schedule: () => {} };
  const sync = { storage: file_sync_storage({ file: join(folder, "sync-peers.json"), back_up_before_replace: () => {} }), address: "https://control.example.org/api/" };
  app = await build_app({ database, control, declared: new Map([["admin", await hash_password("secret words")]]), web_folder: join(folder, "web"), backups: backups as never, sync });
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

  test("asks for a sign-in on an encoded path to a call too", async () => {
    const response = await app.inject({ method: "POST", url: "/%61pi/call/list_devices", payload: [] });
    expect([400, 401]).toContain(response.statusCode);
  });

  test("lets paired devices reach its sync without signing in, and gives only an admin a pairing code", async () => {
    const stranger = await app.inject({ method: "POST", url: "/api/sync/peer", headers: { "content-type": "application/octet-stream", "x-sync-device": "NOBODY" }, payload: Buffer.alloc(64) });
    expect(stranger.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/sync/create_pairing_code", payload: [] })).statusCode).toBe(401);

    const made = await app.inject({ method: "POST", url: "/api/sync/create_pairing_code", headers: { cookie }, payload: [] });
    const offer = decode_pairing_offer((JSON.parse(made.body) as { code: string }).code);
    expect(offer).toMatchObject({ app: "x-control", name: "X-Control server", addresses: ["https://control.example.org/api/"] });
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
