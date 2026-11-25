import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { read_command_file } from "../src/shared/commands/store.ts";
import { paired_store } from "../src/shared/devices/store.ts";
import { bind_store_methods, needs_upgrade, open_store, type StoreMethods } from "../src/shared/store.ts";

function fresh(): { database: DatabaseSync; store: StoreMethods; changes: string[] } {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const changes: string[] = [];
  return { database, store: bind_store_methods(() => database, (method) => changes.push(method)), changes };
}

describe("the run commands", () => {
  test("are added, changed, ordered and removed, each write announced", () => {
    const { store, changes } = fresh();
    const lock = store.save_command({ name: "Lock", command: "loginctl lock-session" });
    const sleep = store.save_command({ name: "Sleep", command: "systemctl suspend" });
    store.save_command({ id: lock, name: "Lock screen", command: "loginctl lock-session" });
    store.move_command(sleep, -1);
    expect(store.list_commands().map((command) => command.name)).toEqual(["Sleep", "Lock screen"]);
    store.remove_command(sleep);
    expect(store.list_commands().map((command) => command.id)).toEqual([lock]);
    expect(changes).toEqual(["save_command", "save_command", "save_command", "move_command", "remove_command"]);
  });

  test("need a name and a command line", () => {
    const { store } = fresh();
    expect(() => store.save_command({ name: " ", command: "true" })).toThrow("name");
    expect(() => store.save_command({ name: "Nothing", command: "" })).toThrow("command line");
  });

  test("keep a history that brings back a removed command", () => {
    const { store } = fresh();
    const id = store.save_command({ name: "Lock", command: "loginctl lock-session" });
    store.remove_command(id);
    const deleted = store.list_recent_versions(10).find((version) => version.kind === "deleted");
    expect(deleted?.snapshot.name).toBe("Lock");
    store.restore_version(deleted!.id);
    expect(store.get_command(id)?.name).toBe("Lock");
  });
});

describe("importing and exporting run commands", () => {
  test("round-trips through JSON and CSV", () => {
    const { store } = fresh();
    store.save_command({ name: "Lock", command: "loginctl lock-session" });
    store.save_command({ name: "Say, hi", command: 'echo "hi"' });
    for (const format of ["json", "csv"] as const) {
      const target = fresh();
      const report = target.store.import_commands(store.export_commands(format), "mine");
      expect(report.added).toBe(2);
      expect(target.store.list_commands().map(({ name, command }) => ({ name, command }))).toEqual(store.list_commands().map(({ name, command }) => ({ name, command })));
    }
  });

  test("shows what differs and lets the user pick which copy wins", () => {
    const { store } = fresh();
    const id = store.save_command({ name: "Lock", command: "loginctl lock-session" });
    const file = store.export_commands("json");
    store.save_command({ id, name: "Lock", command: "xdg-screensaver lock" });

    const preview = store.lookup_command_import(file);
    expect(preview.differing).toHaveLength(1);
    expect(preview.added).toEqual([]);
    expect(store.import_commands(file, "mine")).toEqual({ added: 0, replaced: 0, kept: 1 });
    expect(store.get_command(id)?.command).toBe("xdg-screensaver lock");
    expect(store.import_commands(file, "theirs")).toEqual({ added: 0, replaced: 1, kept: 0 });
    expect(store.get_command(id)?.command).toBe("loginctl lock-session");
  });

  test("refuses another app's file or a newer one", () => {
    expect(() => read_command_file(JSON.stringify({ app: "x-tasks", kind: "commands", version: 1, tables: { commands: [] } }))).toThrow("not made by X-Control");
    expect(() => read_command_file(JSON.stringify({ app: "x-control", kind: "commands", version: 99, tables: { commands: [] } }))).toThrow("newer");
    expect(() => read_command_file("id,name,command\n1,,true")).toThrow("Row 1");
  });
});

describe("settings", () => {
  test("lay the stored values over the defaults", () => {
    const { store } = fresh();
    expect(store.get_settings()["history.keep_days"]).toBe(180);
    store.set_setting("history.keep_days", 30);
    expect(store.get_settings()["history.keep_days"]).toBe(30);
  });

  test("export without this device's own and import only known keys", () => {
    const { store } = fresh();
    store.set_setting("history.keep_days", 30);
    store.set_setting("notify.ping", false);
    const file = store.export_settings();
    expect(JSON.parse(file).settings).not.toHaveProperty("notify.ping");

    const target = fresh();
    const edited = JSON.stringify({ ...JSON.parse(file), settings: { ...JSON.parse(file).settings, unknown_key: 1, "notify.ping": false } });
    expect(target.store.import_settings(edited)).toBe(2);
    expect(target.store.get_settings()).toMatchObject({ "history.keep_days": 30, "notify.ping": true });
    expect(target.store.get_settings()).not.toHaveProperty("unknown_key");
  });
});

describe("the database", () => {
  test("needs no upgrade once opened, and keeps paired devices", () => {
    const { database } = fresh();
    expect(needs_upgrade(database)).toBe(false);
    const paired = paired_store(() => database);
    paired.save({ id: "a".repeat(32), name: "Phone", type: "phone", certificate: "PEM", paired_at: "2026-11-25T00:00:00.000Z", last_address: null, last_seen: null });
    paired.save({ id: "a".repeat(32), name: "Renamed", type: "phone", certificate: "PEM", paired_at: "2026-11-25T00:00:00.000Z", last_address: "10.0.0.2", last_seen: null });
    expect(paired.list()).toHaveLength(1);
    expect(paired.get("a".repeat(32))?.name).toBe("Renamed");
    paired.remove("a".repeat(32));
    expect(paired.get("a".repeat(32))).toBeNull();
  });
});
