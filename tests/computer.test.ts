import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Aedes } from "aedes";
import { afterEach, describe, expect, test } from "vitest";

import type { Notice } from "../src/shared/notices.ts";
import { hidden_secret } from "../src/shared/settings.ts";
import { bind_store_methods, open_store } from "../src/shared/store.ts";
import { home_assistant_settings, start_control, type Control } from "../src/server/control.ts";
import { read_config } from "../src/server/config.ts";
import { read_message } from "../src/server/plugins/desktop_controls.ts";
import { mount_names } from "../src/server/plugins/disks.ts";
import { is_virtual, main_address } from "../src/server/plugins/network.ts";
import { sample_computer, type SampleComputer } from "../src/server/system/sample.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function make_control(): Promise<{ control: Control; computer: SampleComputer; database: DatabaseSync; notices: Notice[]; store: ReturnType<typeof bind_store_methods> }> {
  const folder = mkdtempSync(join(tmpdir(), "x-control-computer-"));
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const computer = sample_computer();
  const notices: Notice[] = [];
  const control = await start_control({
    database: () => database,
    identity_file: join(folder, "identity.json"),
    downloads_folder: join(folder, "Downloads"),
    mounts_folder: join(folder, "mounts"),
    system: computer,
    notify: (notice) => notices.push(notice),
    withdraw: () => {},
    on_change: () => {},
    network: { discovery: false, allow_loopback: true, tcp_ports: { lowest: 42901, highest: 42903 }, payload_ports: { lowest: 42904, highest: 42910 } },
    defaults: { name: "Desk" },
    log: () => {},
  });
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  cleanups.push(() => control.stop());
  const store = bind_store_methods(() => database, (method) => void control.after_store_change(method));
  return { control, computer, database, notices, store };
}

// ── This computer ────────────────────────────────────────────────────────────

describe("this computer", () => {
  test("lists the sample computer's readings from every plugin", async () => {
    const { control } = await make_control();
    const readings = await control.methods.list_readings();
    const ids = readings.map((entity) => entity.id);
    expect(ids).toEqual(expect.arrayContaining(["processor.usage", "processor.memory", "processor.swap", "disks.root_used", "disks.home_used", "network.eth0_download", "network.wifi_signal", "temperatures.cpu_package", "power.shutdown", "power.profile", "power.brightness", "power.battery", "session.locked", "desktop_controls.volume", "desktop_controls.output"]));
    // A card that is down is left out.
    expect(ids).not.toContain("network.wlan0_download");
    expect(readings.find((entity) => entity.id === "processor.memory")?.value).toEqual(expect.any(Number));
    expect(readings.find((entity) => entity.id === "network.address")?.value).toBe("192.168.1.40");
    expect(readings.find((entity) => entity.id === "desktop_controls.output")).toMatchObject({ value: "Speakers", options: ["Speakers", "Headphones"] });
  });

  test("works controls through the computer's services", async () => {
    const { control, computer, notices } = await make_control();
    await control.methods.list_readings();
    expect((await control.methods.set_control("power.profile", "performance")).value).toBe("performance");
    expect((await control.methods.set_control("power.keep_awake", true)).value).toBe(true);
    expect((await control.methods.set_control("session.locked", true)).value).toBe(true);
    expect((await control.methods.set_control("desktop_controls.output", "Headphones")).value).toBe("Headphones");
    expect((await control.methods.set_control("desktop_controls.volume", 50)).value).toBe(50);
    await control.methods.set_control("power.suspend", null);
    await control.methods.set_control("desktop_controls.open", "https://example.org/");
    await control.methods.set_control("desktop_controls.notify", JSON.stringify({ title: "Door", message: "Someone is at the door" }));
    expect(computer.done).toEqual(expect.arrayContaining(["lock", "power suspend", "open https://example.org/"]));
    expect(notices).toEqual([expect.objectContaining({ kind: "remote_message", title: "Door", body: "Someone is at the door" })]);
    await expect(control.methods.set_control("power.profile", "turbo")).rejects.toThrow(/one of/);
    // The keep-awake switch lets go when its plugin stops.
    await control.plugins.disable("power");
    expect(computer.state.kept_awake).toBe(false);
  });

  test("offers a button for each run command and a switch for each service named", async () => {
    const { control, computer, store } = await make_control();
    const id = store.save_command({ name: "Back up now", command: "backup --now" });
    await control.after_store_change("save_command");
    const button = (await control.methods.list_readings()).find((entity) => entity.kind === "button" && entity.name === "Back up now");
    expect(button?.id).toBe(`command_buttons.${id}`);
    await control.methods.set_control(button!.id, null);
    expect(computer.done).toContain("run backup --now");

    store.set_setting("plugins", { system_services: { enabled: true, settings: { system_units: "backup.service", user_units: "syncthing.service" } } });
    await control.after_store_change("set_setting");
    const readings = await control.methods.list_readings();
    expect(readings.find((entity) => entity.id === "system_services.backup_service")?.value).toBe(false);
    expect(readings.find((entity) => entity.id === "system_services.user_syncthing_service")?.value).toBe(true);
    await control.methods.set_control("system_services.backup_service", true);
    expect(computer.done).toContain("start backup.service");
  });

  test("drops a plugin's readings when it is turned off", async () => {
    const { control, store } = await make_control();
    expect((await control.methods.list_readings()).some((entity) => entity.plugin_id === "temperatures")).toBe(true);
    store.set_setting("plugins", { temperatures: { enabled: false } });
    await control.after_store_change("set_setting");
    expect((await control.methods.list_readings()).some((entity) => entity.plugin_id === "temperatures")).toBe(false);
  });
});

// ── Home Assistant settings ──────────────────────────────────────────────────

describe("home assistant settings", () => {
  test("hides the password from the page and keeps it when the placeholder comes back", async () => {
    const { store, database } = await make_control();
    store.set_setting("home_assistant.password", "broker-pass");
    expect(store.get_settings()["home_assistant.password"]).toBe(hidden_secret);
    store.set_setting("home_assistant.password", hidden_secret);
    const row = database.prepare("SELECT value FROM settings WHERE key = 'home_assistant.password'").get() as { value: string };
    expect(JSON.parse(row.value)).toBe("broker-pass");
    // A device's link is its own, so an export leaves it out.
    expect(JSON.parse(store.export_settings()).settings).not.toHaveProperty("home_assistant.broker");
  });

  test("takes fields Settings leaves empty from the config file, the password from its file", () => {
    const folder = mkdtempSync(join(tmpdir(), "x-control-ha-"));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(join(folder, "mqtt-password"), "from-file\n");
    const config = read_config({ database: join(folder, "control.db"), home_assistant: { enabled: true, broker: "mqtt://broker:1883", password_file: join(folder, "mqtt-password"), interval: 30 } });
    expect(home_assistant_settings({}, config.home_assistant)).toMatchObject({ enabled: true, broker: "mqtt://broker:1883", password: "from-file", interval: 30, base_topic: "x-control" });
    expect(home_assistant_settings({ "home_assistant.broker": "mqtt://other:1883", "home_assistant.enabled": false }, config.home_assistant)).toMatchObject({ enabled: false, broker: "mqtt://other:1883" });
    const credential = read_config({ database: join(folder, "control.db"), home_assistant: { password_credential: "mqtt-password" } });
    expect(credential.home_assistant.password_file).toBeUndefined();
  });

  test("connects once Settings turns the link on, and stops when it is turned off", async () => {
    const broker = await Aedes.createBroker();
    const server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => broker.close(() => server.close(() => resolve()))));
    const { control, store } = await make_control();
    expect((await control.methods.get_home_assistant_status()).state).toBe("off");
    store.set_setting("home_assistant.broker", `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`);
    store.set_setting("home_assistant.enabled", true);
    await control.after_store_change("set_setting");
    for (let tries = 0; tries < 300 && control.home_assistant.status().state !== "connected"; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await control.methods.get_home_assistant_status();
    expect(status.state).toBe("connected");
    expect(status.entities).toBeGreaterThan(20);
    store.set_setting("home_assistant.enabled", false);
    await control.after_store_change("set_setting");
    for (let tries = 0; tries < 300 && control.home_assistant.status().state !== "off"; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(control.home_assistant.status().state).toBe("off");
  });
});

// ── Plugin helpers ───────────────────────────────────────────────────────────

describe("plugin helpers", () => {
  test("names mounts and picks the address others reach this computer at", () => {
    expect(mount_names("/")).toEqual({ id: "root", name: "Disk /" });
    expect(mount_names("/mnt/media")).toEqual({ id: "mnt_media", name: "Disk /mnt/media" });
    expect(is_virtual("docker0")).toBe(true);
    expect(is_virtual("enp3s0")).toBe(false);
    expect(main_address([{ name: "docker0", is_up: true, addresses: ["172.17.0.1"], received_bytes: 0, sent_bytes: 0 }, { name: "eth0", is_up: true, addresses: ["fe80::1", "10.0.0.5"], received_bytes: 0, sent_bytes: 0 }])).toBe("10.0.0.5");
    expect(main_address([])).toBeNull();
  });

  test("reads Home Assistant's notify payloads and plain text", () => {
    expect(read_message(JSON.stringify({ title: "Door", message: "Open" }))).toEqual({ title: "Door", body: "Open" });
    expect(read_message("Laundry is done")).toEqual({ title: "Home Assistant", body: "Laundry is done" });
    expect(read_message("[1, 2]")).toEqual({ title: "Home Assistant", body: "[1, 2]" });
  });
});
