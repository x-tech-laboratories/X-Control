import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import type { Notice } from "../src/shared/notices.ts";
import { bind_store_methods, open_store } from "../src/shared/store.ts";
import { start_control, type Control } from "../src/server/control.ts";
import { sample_computer, type SampleComputer } from "../src/server/system/sample.ts";
import type { BatteryState, ContactsState, RemoteCommandState, SftpState, ShareState, SmsState } from "../src/shared/plugins/states.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

interface Side {
  control: Control;
  computer: SampleComputer;
  notices: Notice[];
  database: DatabaseSync;
  folder: string;
  // Sets the plugins setting straight in the database, as Settings would.
  store_set_plugins(records: Record<string, unknown>): void;
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
    mounts_folder: join(folder, "mounts"),
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
  const store_set_plugins = (records: Record<string, unknown>): void => void database.prepare("INSERT INTO settings (key, value) VALUES ('plugins', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(records));
  return { control, computer, notices, database, folder, store_set_plugins };
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

  test("a phone's contacts and messages show up, and a message goes out", async () => {
    const { laptop, phone, phone_id, laptop_id } = await paired_pair();
    const from_phone = phone.control.devices.handle(laptop_id, "test");
    await from_phone.send("kdeconnect.contacts.response_uids_timestamps", { uids: ["u1"], u1: 1 });
    await from_phone.send("kdeconnect.contacts.response_vcards", { uids: ["u1"], u1: "BEGIN:VCARD\nFN:Alex\nTEL:123\nEND:VCARD" });
    await from_phone.send("kdeconnect.sms.messages", { messages: [{ _id: 1, thread_id: 4, addresses: [{ address: "123" }], body: "Hi", date: 1000, type: 1, read: 0 }], version: 2 });
    const contacts = await until(async () => ((await laptop.control.methods.get_device(phone_id)).plugins.contacts as ContactsState | undefined)?.contacts[0], "the contacts");
    expect(contacts.name).toBe("Alex");
    const conversation = await until(async () => ((await laptop.control.methods.get_device(phone_id)).plugins.sms as SmsState | undefined)?.conversations[0], "the messages");
    expect(conversation.messages[0]?.body).toBe("Hi");
    await expect(laptop.control.methods.run_device_action(phone_id, "sms.send", { addresses: ["123"], message: "Hello back" })).resolves.toBeUndefined();
    // Kept in the store, so they show while the phone is away and after the daemon starts again.
    const kept = laptop.database.prepare("SELECT plugin_id FROM device_states ORDER BY plugin_id").all() as { plugin_id: string }[];
    expect(kept.map((row) => row.plugin_id)).toEqual(["contacts", "sms"]);
    const { paired_store } = await import("../src/shared/devices/store.ts");
    expect((paired_store(() => laptop.database).states(phone_id).contacts as ContactsState).contacts[0]?.name).toBe("Alex");
    await laptop.control.methods.unpair_device(phone_id);
    expect(laptop.database.prepare("SELECT COUNT(*) AS count FROM device_states").get()).toEqual({ count: 0 });
  });

  test("this computer's notifications go to the phone, but not X-Control's own nor skipped apps'", async () => {
    const { laptop, phone, laptop_id } = await paired_pair();
    laptop.computer.show_desktop_notice({ app: "X-Control", title: "Echo", body: "from the phone", urgency: "normal" });
    laptop.computer.show_desktop_notice({ app: "Thunderbird", title: "New mail", body: "Hello", urgency: "normal" });
    const shown = await until(async () => ((await phone.control.methods.get_device(laptop_id)).plugins.notification as { notifications: { app: string; title: string; text: string }[] } | undefined)?.notifications, "the notification");
    expect(shown).toEqual([expect.objectContaining({ app: "Thunderbird", title: "New mail", text: "Hello" })]);
    laptop.store_set_plugins({ notification: { enabled: true, settings: { forward_desktop: true, skip_apps: "thunderbird" } } });
    await laptop.control.after_store_change("set_setting");
    laptop.computer.show_desktop_notice({ app: "Thunderbird", title: "Second", body: "skipped", urgency: "normal" });
    laptop.computer.show_desktop_notice({ app: "Calendar", title: "Meeting", body: "at ten", urgency: "normal" });
    await until(async () => ((await phone.control.methods.get_device(laptop_id)).plugins.notification as { notifications: { title: string }[] }).notifications.length === 2, "the second notification");
    const titles = ((await phone.control.methods.get_device(laptop_id)).plugins.notification as { notifications: { title: string }[] }).notifications.map((entry) => entry.title);
    expect(titles).toEqual(["Meeting", "New mail"]);
  });

  test("this computer goes quiet while the phone rings and during the call, and comes back after", async () => {
    const { laptop, phone, laptop_id } = await paired_pair();
    const speakers = () => laptop.computer.state.sinks.find((sink) => sink.is_default)!;
    const from_phone = phone.control.devices.handle(laptop_id, "test");
    await from_phone.send("kdeconnect.telephony", { event: "ringing", contactName: "Alex" });
    await until(() => speakers().volume < 40_000, "the speakers turned down");
    expect(laptop.computer.state.players.find((player) => player.name === "music")?.is_playing).toBe(true);
    await from_phone.send("kdeconnect.telephony", { event: "talking", contactName: "Alex" });
    await until(() => speakers().muted, "the speakers muted");
    expect(laptop.computer.state.players.find((player) => player.name === "music")?.is_playing).toBe(false);
    await from_phone.send("kdeconnect.telephony", { event: "talking", contactName: "Alex", isCancel: true });
    await until(() => !speakers().muted && speakers().volume === 40_000, "the speakers put back");
    await until(() => laptop.computer.state.players.find((player) => player.name === "music")?.is_playing, "the music playing again");
  });

  test("a device moves, clicks and types on this computer", async () => {
    const { laptop, phone, laptop_id } = await paired_pair();
    const from_phone = phone.control.devices.handle(laptop_id, "test");
    await from_phone.send("kdeconnect.mousepad.request", { dx: 3, dy: -2 });
    await from_phone.send("kdeconnect.mousepad.request", { singleclick: true });
    await from_phone.send("kdeconnect.mousepad.request", { key: "hello" });
    await from_phone.send("kdeconnect.mousepad.request", { specialKey: 12, ctrl: true });
    await until(() => laptop.computer.done.includes("key ctrl+Return"), "the keys");
    expect(laptop.computer.done).toEqual(expect.arrayContaining(["move 3 -2", "click left click", "type hello"]));
  });

  test("a phone's files are mounted without keeping its password", async () => {
    const { laptop, phone, phone_id, laptop_id } = await paired_pair();
    const from_phone = phone.control.devices.handle(laptop_id, "test");
    await from_phone.send("kdeconnect.sftp", { ip: "127.0.0.1", port: 1739, user: "kdeconnect", password: "secret-once", path: "/storage", multiPaths: ["/storage/emulated/0"], pathNames: ["All files"] });
    const state = await until(async () => ((await laptop.control.methods.get_device(phone_id)).plugins.sftp as SftpState | undefined)?.folder, "the mount");
    expect(laptop.computer.done.some((line) => line.startsWith("mount kdeconnect@127.0.0.1:1739/storage"))).toBe(true);
    expect(JSON.stringify(await laptop.control.methods.list_devices())).not.toContain("secret-once");
    await laptop.control.methods.run_device_action(phone_id, "sftp.unmount", {});
    expect(laptop.computer.done).toContain(`unmount ${state}`);
  });
});

// ── Reaching by address ──────────────────────────────────────────────────────

describe("reaching a device by address", () => {
  test("reads a host with or without a port", async () => {
    const { parse_address } = await import("../src/server/control.ts");
    expect(parse_address(" 192.168.1.20 ")).toEqual({ host: "192.168.1.20", port: null });
    expect(parse_address("phone.lan:1716")).toEqual({ host: "phone.lan", port: 1716 });
    expect(parse_address("[fe80::1]:1717")).toEqual({ host: "fe80::1", port: 1717 });
    expect(parse_address("fe80::1")).toEqual({ host: "fe80::1", port: null });
    expect(() => parse_address("")).toThrow(/address is needed/);
    expect(() => parse_address("host:70000")).toThrow(/not a port/);
  });

  test("connects over TCP to the port given, as Android needs, and says when nothing answers", async () => {
    const laptop = await make_side("Laptop");
    const phone = await make_side("Phone");
    await laptop.control.methods.connect_address(`127.0.0.1:${phone.control.network.tcp_port()}`);
    await until(() => laptop.control.devices.is_connected(phone.control.identity().device_id), "the connection");
    await expect(laptop.control.methods.connect_address("127.0.0.1:9")).rejects.toThrow(/Could not reach 127.0.0.1 on port 9/);
  });
});
