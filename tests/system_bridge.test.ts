import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import type { Notice } from "../src/shared/notices.ts";
import { create_signer, inside, list_files, mode_text } from "../src/server/system_bridge/files.ts";
import { create_key_store, is_key, make_key } from "../src/server/system_bridge/keys.ts";
import { as_uuid, bridge_version, core_modules, create_modules, processor_temperature } from "../src/server/system_bridge/modules.ts";
import { create_system_bridge_server, frame } from "../src/server/system_bridge/server.ts";
import { sample_computer } from "../src/server/system/sample.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp_folder(): string {
  const folder = mkdtempSync(join(tmpdir(), "x-control-bridge-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

const uuid = as_uuid("0123456789abcdef0123456789abcdef");
const allowed_keys = new Set(["id", "type", "subtype", "data", "message", "module"]);

async function start(): Promise<{ url: string; port: number; key: string; computer: ReturnType<typeof sample_computer>; notices: Notice[]; keys: ReturnType<typeof create_key_store>; music: string }> {
  const folder = temp_folder();
  const music = join(folder, "Music");
  mkdirSync(join(music, "Album"), { recursive: true });
  writeFileSync(join(music, "Album", "01.mp3"), "not really music");
  writeFileSync(join(folder, "secret.txt"), "outside");
  const computer = sample_computer();
  const notices: Notice[] = [];
  const keys = create_key_store(join(folder, "keys.json"));
  const server = create_system_bridge_server({
    port: 0,
    host: "127.0.0.1",
    keys,
    modules: create_modules({ system: computer, uuid: () => uuid }),
    system: computer,
    commands: () => [{ id: "backup", name: "Back up", command: "backup --now" }],
    notify: (notice) => notices.push(notice),
    withdraw: () => {},
    folders: () => [{ key: "music", path: music }],
    uuid: () => uuid,
    mdns: false,
  });
  const port = await server.start();
  cleanups.push(() => server.stop());
  return { url: `http://127.0.0.1:${port}`, port, key: keys.create("Home Assistant").key, computer, notices, keys, music };
}

// A client as Home Assistant's connector is: it signs in once, then sends requests by id.
async function client(port: number, key: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/websocket`);
  cleanups.push(() => socket.terminate());
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "auth", key }));
  const until = async (test: (found: Record<string, unknown>[]) => boolean, what: string): Promise<Record<string, unknown>[]> => {
    for (let tries = 0; tries < 300; tries++) {
      if (test(frames)) return frames;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`waited too long for ${what}; got ${frames.map((entry) => `${String(entry.type)}`).join(", ")}`);
  };
  const request = async (event: string, data: Record<string, unknown>, expected: string): Promise<Record<string, unknown>> => {
    const id = `${event}-${Math.random().toString(16).slice(2)}`;
    socket.send(JSON.stringify({ id, event, data }));
    const found = await until((list) => list.some((entry) => entry.id === id && (entry.type === expected || entry.type === "ERROR")), event);
    return found.find((entry) => entry.id === id && (entry.type === expected || entry.type === "ERROR"))!;
  };
  return { socket, frames, until, request };
}

// ── Keys ─────────────────────────────────────────────────────────────────────

describe("keys", () => {
  test("makes keys in System Bridge's format, with a checksum that catches a changed character", () => {
    const key = make_key();
    expect(key).toMatch(/^system-bridge_client_[0-9A-Za-z]{49}$/);
    expect(is_key(key)).toBe(true);
    const changed = key.slice(0, 30) + (key[30] === "a" ? "b" : "a") + key.slice(31);
    expect(is_key(changed)).toBe(false);
    expect(is_key("ABCD1234")).toBe(false);
  });

  test("keeps only hashes, checks and removes keys, and trades a pairing code once before it expires", () => {
    let now = 1_000_000;
    const store = create_key_store(join(temp_folder(), "keys.json"), () => now);
    const { key, view } = store.create("Home Assistant");
    expect(store.check(key)?.id).toBe(view.id);
    expect(store.list()).toEqual([view]);
    const code = store.pairing_code(10).code;
    const traded = store.pair(code.toLowerCase(), "Kitchen", "client");
    expect(traded && is_key(traded)).toBe(true);
    expect(store.pair(code, "Again", "client")).toBeNull();
    const late = store.pairing_code(10).code;
    now += 11 * 60_000;
    expect(store.pair(late, "Late", "client")).toBeNull();
    store.remove(view.id);
    expect(store.check(key)).toBeNull();
  });
});

// ── Files ────────────────────────────────────────────────────────────────────

describe("media folders", () => {
  test("keeps paths inside the folder, through links too", () => {
    const folder = temp_folder();
    mkdirSync(join(folder, "media", "album"), { recursive: true });
    writeFileSync(join(folder, "outside.txt"), "no");
    symlinkSync(join(folder, "outside.txt"), join(folder, "media", "link.txt"));
    expect(inside(join(folder, "media"), "album")).toContain("album");
    expect(inside(join(folder, "media"), "../outside.txt")).toBeNull();
    expect(inside(join(folder, "media"), "link.txt")).toBeNull();
    expect(inside(join(folder, "media"), null)).toBe(join(folder, "media"));
  });

  test("lists files as GET_FILES answers them, and signs links that expire", async () => {
    const folder = temp_folder();
    writeFileSync(join(folder, "song.mp3"), "x");
    writeFileSync(join(folder, ".hidden"), "x");
    mkdirSync(join(folder, "Album"));
    const files = await list_files(folder);
    expect(files.map((entry) => entry.name)).toEqual(["Album", "song.mp3"]);
    expect(files[1]).toMatchObject({ isDirectory: false, contentType: "audio/mpeg", extension: ".mp3", size: 1 });
    expect(mode_text({ mode: 0o644, isDirectory: () => false })).toBe("-rw-r--r--");
    const signer = create_signer();
    const { url, expires } = signer.url("music", "song.mp3", 60, 1_000_000_000);
    const sig = new URL(url, "http://x").searchParams.get("sig")!;
    expect(signer.check("music", "song.mp3", expires, sig, 1_000_000_000)).toBe(true);
    expect(signer.check("music", "other.mp3", expires, sig, 1_000_000_000)).toBe(false);
    expect(signer.check("music", "song.mp3", expires, sig, (expires + 1) * 1000)).toBe(false);
  });
});

// ── Modules ──────────────────────────────────────────────────────────────────

describe("modules", () => {
  test("answers every core module, never null, with the keys Home Assistant's models need", async () => {
    const modules = create_modules({ system: sample_computer(), uuid: () => uuid });
    for (const name of core_modules) expect(await modules.read(name)).not.toBeNull();
    const system = (await modules.read("system")) as Record<string, unknown>;
    for (const key of ["boot_time", "fqdn", "hostname", "kernel_version", "ip_address_4", "mac_address", "platform_version", "platform", "uptime", "users", "uuid", "version"]) expect(system).toHaveProperty(key);
    expect(system).toMatchObject({ uuid, version: bridge_version, hostname: "sample", power_profiles: ["power-saver", "balanced", "performance"], device_info: { manufacturer: "Sample Maker" } });
    const cpu = (await modules.read("cpu")) as { per_cpu: Record<string, unknown>[]; temperature: number };
    for (const core of cpu.per_cpu) expect(Object.keys(core)).toEqual(expect.arrayContaining(["id", "power", "usage", "voltage"]));
    expect(cpu.temperature).toEqual(expect.any(Number));
    const disks = (await modules.read("disks")) as { devices: { name: string; partitions: { mount_point: string; usage: { percent: number } }[] }[] };
    expect(disks.devices.flatMap((device) => device.partitions.map((partition) => partition.mount_point))).toEqual(["/", "/home"]);
    expect(await modules.read("displays")).toEqual([]);
    expect(((await modules.read("media")) as { status: string; players: unknown[] }).status).toBe("PLAYING");
    expect(((await modules.read("audio")) as { outputs: { id: string; default: boolean }[] }).outputs[0]).toMatchObject({ id: "speakers", default: true });
  });

  test("writes ids as UUIDs and finds the processor's temperature", () => {
    expect(as_uuid("0123456789ABCDEF0123456789abcdef")).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(processor_temperature([{ id: "nvme0_composite", celsius: 40 }, { id: "k10temp_tctl", celsius: 55 }])).toBe(55);
    expect(processor_temperature([])).toBeNull();
  });

  test("never sends a frame with keys the connector does not take", () => {
    expect(Object.keys(frame("a", "DATA_GET", undefined, "Getting data", { module: "cpu" })).every((key) => allowed_keys.has(key))).toBe(true);
    expect(frame("a", "DATA_GET", undefined)).toEqual({ id: "a", type: "DATA_GET", subtype: "NONE", data: null });
  });
});

// ── Server ───────────────────────────────────────────────────────────────────

describe("the server", () => {
  test("answers health without a key and pairs a client by code", async () => {
    const { url, keys } = await start();
    const health = await fetch(`${url}/api/health`);
    expect(health.headers.get("content-type")).toBe("application/json");
    expect(await health.json()).toMatchObject({ status: "healthy", version: bridge_version });
    const code = keys.pairing_code().code;
    const paired = await fetch(`${url}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, client: { id: "ha", name: "Home", platform: "home-assistant" } }) });
    const body = (await paired.json()) as { token: string; service: { id: string; name: string } };
    expect(is_key(body.token)).toBe(true);
    expect(body.service).toEqual({ id: uuid, name: "sample" });
    expect((await fetch(`${url}/api/pair`, { method: "POST", body: JSON.stringify({ code }) })).status).toBe(401);
    const exchange = await fetch(`${url}/api/keys/exchange`, { method: "POST", body: "{}" });
    expect([exchange.status, exchange.headers.get("content-type")]).toEqual([401, "application/json"]);
    expect((await fetch(`${url}/api/data/cpu`)).status).toBe(401);
    expect((await fetch(`${url}/api/data/cpu`, { headers: { authorization: `Bearer ${body.token}` } })).status).toBe(200);
  });

  test("turns a wrong key away with BAD_KEY and closes", async () => {
    const { port } = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/websocket`);
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "auth", key: make_key() }));
    await new Promise((resolve) => socket.once("close", resolve));
    expect(frames).toEqual([{ id: "", type: "ERROR", subtype: "BAD_KEY", data: {}, message: "Invalid key" }]);
  });

  test("sends every module Home Assistant asks for, then pushes to listeners", async () => {
    const { port, key } = await start();
    const home = await client(port, key);
    await home.request("GET_DATA", { modules: [...core_modules] }, "DATA_GET");
    await home.until((frames) => core_modules.every((module) => frames.some((entry) => entry.type === "DATA_UPDATE" && entry.module === module)), "every module");
    for (const entry of home.frames) {
      expect(Object.keys(entry).every((name) => allowed_keys.has(name))).toBe(true);
      expect(entry.data).not.toBeNull();
    }
    const before = home.frames.length;
    const registered = await home.request("REGISTER_DATA_LISTENER", { modules: ["cpu", "media"] }, "DATA_LISTENER_REGISTERED");
    expect(registered.data).toEqual({ modules: ["cpu", "media"] });
    await home.until((frames) => frames.slice(before).filter((entry) => entry.type === "DATA_UPDATE").length >= 2, "a snapshot after registering");
    const settings = await home.request("GET_SETTINGS", {}, "SETTINGS_RESULT");
    expect((settings.data as { commands: { allowlist: unknown[] } }).commands.allowlist).toEqual([{ id: "backup", name: "Back up", command: "backup --now", workingDir: "", arguments: [], prefab: "" }]);
  });

  test("works controls: commands, keys, text, media, notifications and power", async () => {
    const { port, key, computer, notices } = await start();
    const home = await client(port, key);
    const completed = await home.request("COMMAND_EXECUTE", { commandID: "backup" }, "COMMAND_COMPLETED");
    expect(completed.data).toEqual({ commandID: "backup", exitCode: 0, stdout: "", stderr: "" });
    expect(home.frames.some((entry) => entry.type === "COMMAND_EXECUTING")).toBe(true);
    expect((await home.request("COMMAND_EXECUTE", { commandID: "nothing" }, "COMMAND_COMPLETED")).subtype).toBe("COMMAND_NOT_FOUND");
    await home.request("KEYBOARD_TEXT", { text: "hello", delay: null }, "KEYBOARD_TEXT_SENT");
    await home.request("KEYBOARD_KEYPRESS", { key: "enter", modifiers: ["control"], delay: null }, "KEYBOARD_KEY_PRESSED");
    await home.request("MEDIA_CONTROL", { action: "PAUSE", player: "music" }, "MEDIA_CONTROLLED");
    await home.request("AUDIO_CONTROL", { id: "headphones", default: true }, "AUDIO_CONTROLLED");
    await home.request("SYSTEM_SET_POWER_PROFILE", { profile: "performance" }, "SYSTEM_POWER_PROFILE_SET");
    const sent = await home.request("NOTIFICATION", { title: "Door", message: "Open", urgency: "critical" }, "NOTIFICATION_SENT");
    expect((sent.data as { id: number }).id).toBe(1);
    expect(notices).toEqual([expect.objectContaining({ kind: "remote_message", title: "Door", body: "Open", urgency: "critical" })]);
    await home.request("POWER_SLEEP", {}, "POWER_SLEEPING");
    await home.until((frames) => frames.some((entry) => entry.type === "POWER_STATE_CHANGED"), "the power state");
    expect(home.frames.find((entry) => entry.type === "POWER_STATE_CHANGED")).toEqual({ id: "system", type: "POWER_STATE_CHANGED", subtype: "NONE", data: { state: "sleeping" } });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(computer.done).toEqual(expect.arrayContaining(["run backup --now", "type hello", "key ctrl+Return", "media music Pause", "power suspend"]));
    expect(computer.state.profile).toBe("performance");
    expect(computer.state.sinks.find((sink) => sink.is_default)?.name).toBe("headphones");
    expect((await home.request("TELEPORT", {}, "TELEPORTED")).message).toBe("Method not found");
  });

  test("lists media folders and hands out signed links to their files, nothing outside them", async () => {
    const { url, port, key } = await start();
    const home = await client(port, key);
    const folders = await home.request("GET_DIRECTORIES", {}, "DIRECTORIES");
    expect(folders.data).toEqual([{ key: "music", path: expect.stringContaining("Music") }]);
    const files = await home.request("GET_FILES", { base: "music", path: "Album" }, "FILES");
    expect((files.data as { name: string }[]).map((entry) => entry.name)).toEqual(["01.mp3"]);
    expect((await home.request("GET_FILES", { base: "music", path: "../" }, "FILES")).subtype).toBe("BAD_DIRECTORY");
    const link = await fetch(`${url}/api/media/file/url`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ base: "music", path: "Album/01.mp3", expiresIn: 60 }) });
    const { url: file_url } = (await link.json()) as { url: string };
    const file = await fetch(`${url}${file_url}`);
    expect([file.status, file.headers.get("content-type"), await file.text()]).toEqual([200, "audio/mpeg", "not really music"]);
    expect((await fetch(`${url}${file_url.replace(/sig=[0-9a-f]+/, "sig=00")}`)).status).toBe(401);
    expect((await fetch(`${url}/api/media/file/url`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ base: "music", path: "../secret.txt" }) })).status).toBe(404);
  });
});

// ── Control ──────────────────────────────────────────────────────────────────

describe("in the control core", () => {
  test("starts when Settings turns it on, with keys kept beside the identity, and stops when turned off", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { open_store, bind_store_methods } = await import("../src/shared/store.ts");
    const { start_control } = await import("../src/server/control.ts");
    const { system_bridge_summary } = await import("../src/web/settings/SystemBridgeSettings.tsx");
    const folder = temp_folder();
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const control = await start_control({
      database: () => database,
      identity_file: join(folder, "identity.json"),
      downloads_folder: join(folder, "Downloads"),
      mounts_folder: join(folder, "mounts"),
      system: sample_computer(),
      notify: () => {},
      withdraw: () => {},
      on_change: () => {},
      network: { discovery: false, allow_loopback: true, tcp_ports: { lowest: 42921, highest: 42923 }, payload_ports: { lowest: 42924, highest: 42930 } },
      log: () => {},
    });
    cleanups.push(() => control.stop());
    const store = bind_store_methods(() => database, (method) => void control.after_store_change(method));
    expect((await control.methods.get_system_bridge_status()).state).toBe("off");
    store.set_setting("system_bridge.port", 49371);
    store.set_setting("system_bridge.enabled", true);
    await control.after_store_change("set_setting");
    const status = await control.methods.get_system_bridge_status();
    expect(status).toMatchObject({ state: "listening", port: 49371, clients: 0, uuid: as_uuid(control.identity().device_id) });
    expect(system_bridge_summary(status)).toBe("Listening on port 49371, 0 clients signed in.");
    const { key, view } = await control.methods.create_system_bridge_key("Home Assistant");
    expect(await control.methods.list_system_bridge_keys()).toEqual([view]);
    const home = await client(49371, key);
    await home.request("GET_DATA", { modules: ["system"] }, "DATA_GET");
    await home.until((frames) => frames.some((entry) => entry.module === "system"), "the system module");
    expect((home.frames.find((entry) => entry.module === "system")!.data as { uuid: string }).uuid).toBe(status.uuid);
    expect((await control.methods.create_system_bridge_pairing_code()).code).toMatch(/^[A-Z2-9]{8}$/);
    store.set_setting("system_bridge.enabled", false);
    await control.after_store_change("set_setting");
    expect((await control.methods.get_system_bridge_status()).state).toBe("off");
    expect(system_bridge_summary({ state: "failed", port: 80, clients: 0, uuid, error: "EACCES" })).toBe("Could not listen on port 80: EACCES");
  });
});
