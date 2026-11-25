import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import type { Notice } from "../src/shared/notices.ts";
import { bind_store_methods, open_store } from "../src/shared/store.ts";
import { start_control, type Control } from "../src/server/control.ts";
import { sample_computer, type SampleComputer } from "../src/server/system/sample.ts";
import type { BatteryState, RemoteCommandState, ShareState } from "../src/shared/plugins/states.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

interface Side {
  control: Control;
  computer: SampleComputer;
  notices: Notice[];
  database: DatabaseSync;
  folder: string;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let next_port = 42716;

async function make_side(name: string): Promise<Side> {
  const folder = mkdtempSync(join(tmpdir(), "x-control-test-"));
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const computer = sample_computer();
  const notices: Notice[] = [];
  const lowest = next_port;
  next_port += 3;
  const control = await start_control({
    database: () => database,
    identity_file: join(folder, "identity.json"),
    downloads_folder: join(folder, "Downloads"),
    system: computer,
    notify: (notice) => notices.push(notice),
    withdraw: () => {},
    on_change: () => {},
    network: { discovery: false, allow_loopback: true, tcp_ports: { lowest, highest: lowest + 2 }, payload_ports: { lowest: 43739, highest: 43764 } },
    defaults: { name, type: name === "Phone" ? "phone" : "desktop" },
    log: () => {},
  });
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  cleanups.push(() => control.stop());
  return { control, computer, notices, database, folder };
}

async function until<Value>(read: () => Value | undefined | null | false | Promise<Value | undefined | null | false>, what: string): Promise<Value> {
  for (let tries = 0; tries < 300; tries++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waited too long for ${what}`);
}

// Connects the two and pairs them, the laptop asking and the phone accepting.
async function paired_pair(): Promise<{ laptop: Side; phone: Side; phone_id: string; laptop_id: string }> {
  const laptop = await make_side("Laptop");
  const phone = await make_side("Phone");
  const phone_id = phone.control.identity().device_id;
  const laptop_id = laptop.control.identity().device_id;
  await laptop.control.network.connect("127.0.0.1", phone.control.network.tcp_port(), phone_id);
  await until(() => phone.control.devices.is_connected(laptop_id), "the connection");
  await laptop.control.methods.pair_device(phone_id);
  const incoming = await until(async () => (await phone.control.methods.get_device(laptop_id)).pair_state === "incoming", "the request");
  expect(incoming).toBe(true);
  await phone.control.methods.accept_pairing(laptop_id);
  await until(async () => (await laptop.control.methods.get_device(phone_id)).pair_state === "paired", "the pairing");
  return { laptop, phone, phone_id, laptop_id };
}

// ── Pairing ──────────────────────────────────────────────────────────────────

describe("pairing", () => {
  test("shows the same verification key on both sides and keeps the device once accepted", async () => {
    const laptop = await make_side("Laptop");
    const phone = await make_side("Phone");
    const phone_id = phone.control.identity().device_id;
    const laptop_id = laptop.control.identity().device_id;
    await laptop.control.network.connect("127.0.0.1", phone.control.network.tcp_port(), phone_id);
    await until(() => phone.control.devices.is_connected(laptop_id), "the connection");

    await laptop.control.methods.pair_device(phone_id);
    const asked = await until(async () => {
      const device = await phone.control.methods.get_device(laptop_id);
      return device.pair_state === "incoming" ? device : null;
    }, "the request");
    const asking = await laptop.control.methods.get_device(phone_id);
    expect(asking.pair_state).toBe("requested");
    expect(asked.verification_key).toMatch(/^[0-9A-F]{8}$/);
    expect(asking.verification_key).toBe(asked.verification_key);
    expect(phone.notices.map((notice) => notice.kind)).toContain("pair_request");

    await phone.control.methods.accept_pairing(laptop_id);
    await until(async () => (await laptop.control.methods.get_device(phone_id)).pair_state === "paired", "the pairing");
    expect(phone.database.prepare("SELECT name FROM paired_devices").all()).toEqual([{ name: "Laptop" }]);
    expect(laptop.database.prepare("SELECT name FROM paired_devices").all()).toEqual([{ name: "Phone" }]);
  });

  test("a rejected request leaves both unpaired", async () => {
    const laptop = await make_side("Laptop");
    const phone = await make_side("Phone");
    const phone_id = phone.control.identity().device_id;
    const laptop_id = laptop.control.identity().device_id;
    await laptop.control.network.connect("127.0.0.1", phone.control.network.tcp_port(), phone_id);
    await until(() => phone.control.devices.is_connected(laptop_id), "the connection");
    await laptop.control.methods.pair_device(phone_id);
    await until(async () => (await phone.control.methods.get_device(laptop_id)).pair_state === "incoming", "the request");

    await phone.control.methods.reject_pairing(laptop_id);
    await until(async () => (await laptop.control.methods.get_device(phone_id)).pair_state === "unpaired", "the refusal");
    expect(laptop.database.prepare("SELECT * FROM paired_devices").all()).toEqual([]);
  });

  test("unpairing on one side unpairs the other", async () => {
    const { laptop, phone, phone_id, laptop_id } = await paired_pair();
    await laptop.control.methods.unpair_device(phone_id);
    await until(async () => (await phone.control.methods.get_device(laptop_id)).pair_state === "unpaired", "the unpairing");
    expect(phone.database.prepare("SELECT * FROM paired_devices").all()).toEqual([]);
  });

  test("an unpaired device's packets reach no plugin", async () => {
    const laptop = await make_side("Laptop");
    const phone = await make_side("Phone");
    const phone_id = phone.control.identity().device_id;
    await laptop.control.network.connect("127.0.0.1", phone.control.network.tcp_port(), phone_id);
    await until(() => laptop.control.devices.is_connected(phone_id), "the connection");
    await expect(laptop.control.methods.run_device_action(phone_id, "ping.send", {})).rejects.toThrow("not paired");
  });
});

// ── Plugins ──────────────────────────────────────────────────────────────────

describe("plugins between paired devices", () => {
  test("a ping shows a notice on the other side", async () => {
    const { laptop, phone, phone_id } = await paired_pair();
    await laptop.control.methods.run_device_action(phone_id, "ping.send", { message: "Hi there" });
    const notice = await until(() => phone.notices.find((candidate) => candidate.kind === "ping"), "the ping");
    expect(notice).toMatchObject({ title: "Laptop", body: "Hi there" });
  });

  test("each side learns the other's battery once paired", async () => {
    const { laptop, phone_id } = await paired_pair();
    const battery = await until(async () => (await laptop.control.methods.get_device(phone_id)).plugins.battery as BatteryState | undefined, "the battery");
    expect(battery).toEqual({ charge: 64, is_charging: false });
  });

  test("text sent to a device's clipboard lands on its computer", async () => {
    const { laptop, phone, phone_id } = await paired_pair();
    await laptop.control.methods.run_device_action(phone_id, "clipboard.send", { text: "copied words" });
    await until(() => phone.computer.state.clipboard === "copied words", "the clipboard");
  });

  test("a device lists this computer's commands and runs one", async () => {
    const { laptop, phone, phone_id, laptop_id } = await paired_pair();
    const store = bind_store_methods(() => laptop.database, () => {});
    const id = store.save_command({ name: "Lock screen", command: "loginctl lock-session" });
    await laptop.control.after_store_change("save_command");

    const listed = await until(async () => ((await phone.control.methods.get_device(laptop_id)).plugins.runcommand as RemoteCommandState | undefined)?.commands[0], "the command list");
    expect(listed).toEqual({ key: id, name: "Lock screen", command: "loginctl lock-session" });
    await phone.control.methods.run_device_action(laptop_id, "runcommand.run", { key: id });
    await until(() => laptop.computer.done.includes("run loginctl lock-session"), "the command");
    void phone_id;
  });

  test("a shared file lands in the downloads folder", async () => {
    const { laptop, phone, phone_id, laptop_id } = await paired_pair();
    const file = join(laptop.folder, "note.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "shared contents");
    await laptop.control.methods.run_device_action(phone_id, "share.file", { path: file });
    const shared = await until(async () => ((await phone.control.methods.get_device(laptop_id)).plugins.share as ShareState | undefined)?.received[0], "the file");
    expect(shared.kind).toBe("file");
    expect(readFileSync(shared.value, "utf8")).toBe("shared contents");
  });

  test("a device can lock this computer", async () => {
    const { laptop, phone, laptop_id } = await paired_pair();
    await phone.control.methods.run_device_action(laptop_id, "lock.lock", {});
    await until(() => laptop.computer.state.locked, "the lock");
  });

  test("a device controls this computer's media players", async () => {
    const { laptop, phone, laptop_id } = await paired_pair();
    await phone.control.methods.run_device_action(laptop_id, "mpris.act", { player: "music", action: "Pause" });
    await until(() => laptop.computer.done.includes("media music Pause"), "the pause");
  });

  test("a plugin turned off in Settings stops answering", async () => {
    const { laptop, phone, phone_id, laptop_id } = await paired_pair();
    const store = bind_store_methods(() => phone.database, () => {});
    store.set_setting("plugins", { ping: { enabled: false } });
    await phone.control.after_store_change("set_setting");
    expect(phone.control.plugins.list().find((status) => status.manifest.id === "ping")?.state).toBe("off");
    await expect(phone.control.methods.run_device_action(laptop_id, "ping.send", {})).rejects.toThrow("plugin may be off");
    void laptop;
    void phone_id;
  });
});
