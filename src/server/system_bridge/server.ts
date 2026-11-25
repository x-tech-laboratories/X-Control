// A System Bridge server, so Home Assistant's system_bridge integration and System Bridge's own clients reach this
// computer as they reach System Bridge: its HTTP routes for health, pairing, data and media files, its WebSocket API
// with the data modules pushed as they change and the controls they send, and the mDNS record that lets Home
// Assistant find it. Clients sign in with keys made under Settings or traded for a pairing code.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename } from "node:path";

import { Bonjour } from "bonjour-service";
import { WebSocketServer, type WebSocket } from "ws";

import type { Notice } from "../../shared/notices.ts";
import { main_address } from "../plugins/network.ts";
import type { RunCommand } from "../plugins/api.ts";
import type { Modifier, SystemServices } from "../system/services.ts";
import { content_type_of, create_signer, inside, list_files, type MediaFolder } from "./files.ts";
import type { KeyStore } from "./keys.ts";
import { all_modules, bridge_version, is_module, type ModuleName, type Modules } from "./modules.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export const default_bridge_port = 9170;

export interface BridgeServerOptions {
  port: number;
  host?: string;
  keys: KeyStore;
  modules: Modules;
  system: SystemServices;
  commands: () => RunCommand[];
  notify: (notice: Notice) => void;
  withdraw: (key: string) => void;
  folders: () => MediaFolder[];
  uuid: () => string;
  // Advertise the server over mDNS as _system-bridge._tcp, so Home Assistant offers to add it.
  mdns: boolean;
  // Seconds between pushes of media, battery and audio; the rest go a third as often.
  push_seconds?: number;
  log?: (message: string) => void;
}

export interface BridgeServer {
  // Listens and gives back the port.
  start(): Promise<number>;
  stop(): Promise<void>;
  clients(): number;
}

// ── Frames ───────────────────────────────────────────────────────────────────

type Frame = { id: string; type: string; subtype: string; data: unknown; message?: string; module?: string };

// A frame with only the keys the connector's Response takes; any other key breaks Home Assistant's listener.
export function frame(id: string, type: string, data: unknown, message?: string, extra: { subtype?: string; module?: string } = {}): Frame {
  return { id, type, subtype: extra.subtype ?? "NONE", data: data === undefined ? null : data, ...(message ? { message } : {}), ...(extra.module ? { module: extra.module } : {}) };
}

function error_frame(id: string, subtype: string, message: string, data: unknown = null): Frame {
  return frame(id, "ERROR", data, message, { subtype });
}

class BadRequest extends Error {
  readonly subtype: string;
  constructor(message: string, subtype = "BAD_REQUEST") {
    super(message);
    this.subtype = subtype;
  }
}

// ── Keys pressed ─────────────────────────────────────────────────────────────

// System Bridge's key names, as robotjs has them, in the X11 names remote input presses.
const key_names: Record<string, string> = {
  enter: "Return", return: "Return", backspace: "BackSpace", tab: "Tab", escape: "Escape", delete: "Delete", home: "Home", end: "End",
  pageup: "Prior", pagedown: "Next", up: "Up", down: "Down", left: "Left", right: "Right", space: " ",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `F${index + 1}`])),
};

const media_keys: Record<string, "PlayPause" | "Next" | "Previous" | "Stop"> = { audio_play: "PlayPause", audio_pause: "PlayPause", audio_next: "Next", audio_prev: "Previous", audio_stop: "Stop" };

function modifiers_of(value: unknown): Modifier[] {
  const names: Record<string, Modifier> = { control: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift", command: "super", super: "super", meta: "super" };
  return Array.isArray(value) ? value.flatMap((entry) => (typeof entry === "string" && names[entry.toLowerCase()] ? [names[entry.toLowerCase()]!] : [])) : [];
}

// ── Server ───────────────────────────────────────────────────────────────────

interface Client {
  socket: WebSocket;
  authenticated: boolean;
  modules: Set<ModuleName>;
}

export function create_system_bridge_server(options: BridgeServerOptions): BridgeServer {
  const log = options.log ?? (() => {});
  const { system } = options;
  const signer = create_signer();
  const clients = new Set<Client>();
  const last_sent = new Map<ModuleName, string>();
  let http: Server | null = null;
  let sockets: WebSocketServer | null = null;
  let bonjour: Bonjour | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tick = 0;
  let notification_id = 0;

  const send = (client: Client, message: Frame): void => {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message));
  };
  const broadcast = (message: Frame): void => {
    for (const client of clients) if (client.authenticated) send(client, message);
  };

  // Reads a module and sends it to the clients given, or to every client listening for it when it changed.
  async function push(module: ModuleName, to?: Client[]): Promise<void> {
    const data = await options.modules.read(module);
    const text = JSON.stringify(data);
    const listening = to ?? [...clients].filter((client) => client.authenticated && client.modules.has(module));
    if (!to && last_sent.get(module) === text) return;
    if (!to) last_sent.set(module, text);
    for (const client of listening) send(client, frame("system", "DATA_UPDATE", data, undefined, { module }));
  }
  const push_soon = (module: ModuleName): void => void setTimeout(() => void push(module).catch(() => {}), 500);

  // ── Events ─────────────────────────────────────────────────────────────────

  const text_of = (data: Record<string, unknown>, key: string): string => (typeof data[key] === "string" ? (data[key] as string) : "");

  async function power(event: string, id: string, client: Client): Promise<void> {
    const responses: Record<string, string> = { POWER_SLEEP: "POWER_SLEEPING", POWER_HIBERNATE: "POWER_HIBERNATING", POWER_RESTART: "POWER_RESTARTING", POWER_SHUTDOWN: "POWER_SHUTTINGDOWN", POWER_LOCK: "POWER_LOCKING", POWER_LOGOUT: "POWER_LOGGINGOUT" };
    if (event === "POWER_LOGOUT") throw new BadRequest("Logging out is not offered by X-Control.");
    send(client, frame(id, responses[event]!, {}, "Power command received"));
    if (event === "POWER_LOCK") return void (await system.session.lock());
    const action = ({ POWER_SLEEP: "suspend", POWER_HIBERNATE: "hibernate", POWER_RESTART: "restart", POWER_SHUTDOWN: "shutdown" } as const)[event as "POWER_SLEEP"];
    broadcast(frame("system", "POWER_STATE_CHANGED", { state: action === "suspend" || action === "hibernate" ? "sleeping" : "shutting_down" }));
    log(`System Bridge: ${action} asked for`);
    setTimeout(() => void system.power.act(action).catch((error: unknown) => log(`System Bridge ${action}: ${String(error)}`)), 1000);
  }

  async function handle(client: Client, id: string, event: string, data: Record<string, unknown>): Promise<Frame | null> {
    switch (event) {
      case "GET_DATA": {
        const modules = (Array.isArray(data.modules) ? data.modules : []).filter(is_module);
        send(client, frame(id, "DATA_GET", { modules }, "Getting data"));
        for (const module of modules) await push(module, [client]);
        return null;
      }
      case "REGISTER_DATA_LISTENER": {
        const modules = (Array.isArray(data.modules) ? data.modules : []).filter(is_module);
        for (const module of modules) client.modules.add(module);
        send(client, frame(id, "DATA_LISTENER_REGISTERED", { modules }, "Listener registered"));
        // A fresh snapshot, since Home Assistant asks for nothing more after it registers.
        for (const module of modules) await push(module, [client]);
        return null;
      }
      case "UNREGISTER_DATA_LISTENER":
        client.modules.clear();
        return frame(id, "DATA_LISTENER_UNREGISTERED", data, "Listener unregistered");
      case "GET_SETTINGS":
        return frame(id, "SETTINGS_RESULT", settings(), "Got settings");
      case "COMMAND_EXECUTE": {
        const command_id = text_of(data, "commandID");
        const command = options.commands().find((entry) => entry.id === command_id);
        if (!command) throw new BadRequest(`No command ${command_id}.`, "COMMAND_NOT_FOUND");
        send(client, frame(id, "COMMAND_EXECUTING", { commandID: command_id }, "Command is executing"));
        const result = await system.run_shell(command.command);
        return frame(id, "COMMAND_COMPLETED", { commandID: command_id, exitCode: result.exit_code, stdout: result.output, stderr: "" }, result.exit_code === 0 ? "Command executed successfully" : "Command failed");
      }
      case "POWER_SLEEP":
      case "POWER_HIBERNATE":
      case "POWER_RESTART":
      case "POWER_SHUTDOWN":
      case "POWER_LOCK":
      case "POWER_LOGOUT":
        await power(event, id, client);
        return null;
      case "KEYBOARD_KEYPRESS": {
        const key = text_of(data, "key");
        if (!key) throw new BadRequest("A key is needed.");
        const media = media_keys[key.toLowerCase()];
        if (media) {
          const players = await system.media.list_players();
          const player = players.find((entry) => entry.is_playing) ?? players[0];
          if (player) await system.media.act(player.name, media);
        } else {
          const named = key_names[key.toLowerCase()] ?? key;
          const modifiers = modifiers_of(data.modifiers);
          if (named.length === 1 && modifiers.length === 0) await system.input.type(named);
          else await system.input.key(named, modifiers);
        }
        return frame(id, "KEYBOARD_KEY_PRESSED", data, "Keyboard key pressed");
      }
      case "KEYBOARD_TEXT": {
        const text = text_of(data, "text");
        if (!text) throw new BadRequest("Text is needed.");
        await system.input.type(text);
        return frame(id, "KEYBOARD_TEXT_SENT", data, "Keyboard text sent");
      }
      case "OPEN": {
        const target = text_of(data, "url") || text_of(data, "path");
        if (!target) throw new BadRequest("A path or URL is needed.");
        if (!data.url && !(await stat(target).then(() => true, () => false))) throw new BadRequest("Path does not exist");
        await system.open(target);
        return frame(id, "OPENED", data, data.url ? "Opened URL" : "Opened path");
      }
      case "MEDIA_CONTROL": {
        const players = await system.media.list_players();
        const player = players.find((entry) => entry.name === data.player) ?? players.find((entry) => entry.is_playing) ?? players[0];
        if (!player) throw new BadRequest("No media player is open.");
        const action = text_of(data, "action");
        const simple: Record<string, "Play" | "Pause" | "Stop" | "Next" | "Previous"> = { PLAY: "Play", PAUSE: "Pause", STOP: "Stop", NEXT: "Next", PREVIOUS: "Previous" };
        if (simple[action]) await system.media.act(player.name, simple[action]);
        else if (action === "SEEK" && typeof data.position === "number") await system.media.set_position(player.name, data.position * 1000);
        else if (action === "SET_VOLUME" && typeof data.volume === "number") await system.media.set_volume(player.name, data.volume * 100);
        else throw new BadRequest(`${action || "That action"} is not offered by X-Control.`);
        push_soon("media");
        return frame(id, "MEDIA_CONTROLLED", data, "Media controlled");
      }
      case "AUDIO_CONTROL": {
        const sink = text_of(data, "id");
        if (!sink) throw new BadRequest("An output's id is needed.");
        if (typeof data.volume === "number") await system.volume.set_volume(sink, Math.round((data.volume / 100) * 65_536));
        if (typeof data.muted === "boolean") await system.volume.set_muted(sink, data.muted);
        if (data.default === true) await system.volume.make_default(sink);
        push_soon("audio");
        return frame(id, "AUDIO_CONTROLLED", data, "Audio controlled");
      }
      case "SYSTEM_SET_POWER_PROFILE":
        await system.power.set_profile(text_of(data, "profile"));
        push_soon("system");
        return frame(id, "SYSTEM_POWER_PROFILE_SET", data, "Power profile set");
      case "SYSTEM_SET_KEEP_AWAKE":
        await system.power.keep_awake(data.enabled === true);
        push_soon("system");
        return frame(id, "SYSTEM_KEEP_AWAKE_SET", data, "Keep awake set");
      case "NOTIFICATION": {
        const title = text_of(data, "title");
        const message = text_of(data, "message");
        if (!title && !message) throw new BadRequest("A notification needs a title or a message.");
        const notification = ++notification_id;
        options.notify({ kind: "remote_message", key: `system_bridge:${notification}`, title: title || "Home Assistant", body: message, urgency: data.urgency === "critical" ? "critical" : data.urgency === "low" ? "low" : "normal" });
        broadcast(frame("system", "NOTIFICATION_SENT", { id: notification, title, message, buttons: Array.isArray(data.buttons) ? data.buttons : [] }));
        return frame(id, "NOTIFICATION_SENT", { ...data, id: notification }, "Notification sent");
      }
      case "NOTIFICATION_DISMISS":
        options.withdraw(`system_bridge:${String(data.id)}`);
        return frame(id, "NOTIFICATION_DISMISSED", data, "Notification dismissed");
      case "CLIPBOARD_GET_TEXT":
        return frame(id, "CLIPBOARD_TEXT", { text: (await system.clipboard.read()) ?? "" }, "Got clipboard text");
      case "CLIPBOARD_SET_TEXT":
        await system.clipboard.write(text_of(data, "text"));
        return frame(id, "CLIPBOARD_TEXT_SET", data, "Clipboard text set");
      case "GET_DIRECTORIES":
        return frame(id, "DIRECTORIES", options.folders().map(({ key, path }) => ({ key, path })), "Got directories");
      case "GET_FILES": {
        const base = options.folders().find((folder) => folder.key === data.base);
        const folder = base ? inside(base.path, typeof data.path === "string" ? data.path : null) : null;
        if (!folder) throw new BadRequest("That folder is not one System Bridge offers.", "BAD_DIRECTORY");
        return frame(id, "FILES", await list_files(folder), "Got files");
      }
      case "GET_DIAGNOSTICS":
        return frame(id, "DIAGNOSTICS", { version: bridge_version, platform: "linux", architecture: process.arch === "x64" ? "amd64" : process.arch, started_at: Math.round(Date.now() / 1000 - process.uptime()), log_level: "WARN", modules: all_modules.map((name) => ({ name, has_data: true, updated: null, failures: 0, last_error: null, last_error_at: null })), settings: null, recent_errors: [] }, "Got diagnostics");
      default:
        return frame(id, "ERROR", { message: { id, event, data } }, "Method not found", { subtype: "" });
    }
  }

  function settings(): Record<string, unknown> {
    return {
      autostart: false,
      systemTray: false,
      logLevel: "WARN",
      theme: "",
      hotkeys: [],
      cameras: { capture: false },
      commands: { allowlist: options.commands().map((command) => ({ id: command.id, name: command.name, command: command.command, workingDir: "", arguments: [], prefab: "" })) },
      desktop: { windowTitles: false, hyprlandCode: false },
      disks: { allowedSecondaryMountPoints: [] },
      media: { directories: options.folders().map((folder) => ({ name: folder.key, path: folder.path })) },
    };
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  function connect(socket: WebSocket): void {
    const client: Client = { socket, authenticated: false, modules: new Set() };
    clients.add(client);
    // A client that has not signed in within ten seconds is dropped.
    const deadline = setTimeout(() => (client.authenticated ? undefined : socket.close()), 10_000);
    socket.on("close", () => {
      clearTimeout(deadline);
      clients.delete(client);
    });
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return send(client, error_frame("", "invalid_message", "Failed to parse message", {}));
      }
      if (message.type === "auth") {
        if (typeof message.key === "string" && options.keys.check(message.key)) {
          client.authenticated = true;
          clearTimeout(deadline);
          return;
        }
        send(client, error_frame("", "BAD_KEY", "Invalid key", {}));
        return void socket.close();
      }
      const id = typeof message.id === "string" ? message.id : "";
      if (!client.authenticated) {
        // Old clients send a key with every message instead of signing in first.
        if (typeof message.token === "string" && options.keys.check(message.token)) client.authenticated = true;
        else return send(client, error_frame(id, "BAD_TOKEN", "Invalid token", {}));
      }
      const data = message.data && typeof message.data === "object" && !Array.isArray(message.data) ? (message.data as Record<string, unknown>) : {};
      handle(client, id, String(message.event ?? ""), data).then(
        (reply) => (reply ? send(client, reply) : undefined),
        (error: unknown) => send(client, error instanceof BadRequest ? error_frame(id, error.subtype, error.message) : error_frame(id, "BAD_REQUEST", error instanceof Error ? error.message : String(error))),
      );
    });
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  async function body_of(request: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) throw new BadRequest("Too large");
      chunks.push(chunk as Buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest("Expected a JSON object");
    return parsed as Record<string, unknown>;
  }

  const bearer = (request: IncomingMessage): string => /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.authorization ?? "")?.[1] ?? "";

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/health") return json(response, 200, { status: "healthy", timestamp: new Date().toISOString(), version: bridge_version });
    if (request.method === "POST" && path === "/api/pair") {
      const body = await body_of(request).catch(() => null);
      const code = typeof body?.code === "string" ? body.code : "";
      if (!code) return json(response, 400, { error: "Invalid pairing request" });
      const client = (body?.client ?? {}) as Record<string, unknown>;
      const key = options.keys.pair(code, typeof client.name === "string" && client.name ? client.name : "Home Assistant", "client");
      if (!key) return json(response, 401, { error: "Unknown or expired pairing code" });
      return json(response, 200, { token: key, service: { id: options.uuid(), name: (await system.readings.system_info()).hostname } });
    }
    // X-Control has no shared token to trade for a key.
    if (request.method === "POST" && path === "/api/keys/exchange") return json(response, 401, { error: "Invalid API token" });
    if (request.method === "GET" && path === "/api/media/file/data") return serve_file(url, request, response);
    if (!options.keys.check(bearer(request))) return json(response, 401, { error: "Invalid key" });
    if (request.method === "GET" && path.startsWith("/api/data/")) {
      const module = path.slice("/api/data/".length);
      if (!is_module(module)) return json(response, 404, { error: "Module not found" });
      return json(response, 200, await options.modules.read(module));
    }
    if (request.method === "POST" && path === "/api/media/file/url") {
      const body = await body_of(request);
      const base = options.folders().find((folder) => folder.key === body.base);
      const relative = typeof body.path === "string" ? body.path : "";
      if (!base || !inside(base.path, relative)) return json(response, 404, { error: "File not found" });
      return json(response, 200, signer.url(base.key, relative, Number(body.expiresIn) || 3600));
    }
    return json(response, 404, { error: "Not found" });
  }

  async function serve_file(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const base_key = url.searchParams.get("base") ?? "";
    const relative = url.searchParams.get("path") ?? "";
    const signed = signer.check(base_key, relative, Number(url.searchParams.get("expires")), url.searchParams.get("sig") ?? "");
    if (!signed && !options.keys.check(bearer(request))) return json(response, 401, { error: "Invalid or expired link" });
    const base = options.folders().find((folder) => folder.key === base_key);
    const file = base ? inside(base.path, relative) : null;
    const stats = file ? await stat(file).catch(() => null) : null;
    if (!file || !stats?.isFile()) return json(response, 404, { error: "File not found" });
    response.writeHead(200, { "content-type": content_type_of(file) ?? "application/octet-stream", "content-length": String(stats.size), "content-disposition": `inline; filename="${basename(file).replace(/"/g, "")}"` });
    createReadStream(file).pipe(response);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  return {
    async start() {
      http = createServer((request, response) => {
        route(request, response).catch((error: unknown) => (response.headersSent ? response.destroy() : json(response, error instanceof BadRequest ? 400 : 500, { error: error instanceof Error ? error.message : String(error) })));
      });
      sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
      http.on("upgrade", (request, socket, head) => {
        if (new URL(request.url ?? "/", "http://localhost").pathname !== "/api/websocket") return void socket.destroy();
        sockets!.handleUpgrade(request, socket, head, connect);
      });
      await new Promise<void>((resolve, reject) => {
        http!.once("error", reject);
        http!.listen(options.port, options.host ?? "0.0.0.0", () => resolve());
      });
      const port = (http.address() as { port: number }).port;
      const seconds = options.push_seconds ?? 10;
      timer = setInterval(() => {
        tick++;
        const due = all_modules.filter((module) => tick % 3 === 0 || module === "media" || module === "battery" || module === "audio");
        for (const module of due) if ([...clients].some((client) => client.modules.has(module))) void push(module).catch(() => {});
      }, seconds * 1000);
      if (options.mdns) {
        const interfaces = await system.readings.interfaces().catch(() => []);
        const info = await system.readings.system_info();
        bonjour = new Bonjour({}, (error: Error) => log(`System Bridge mDNS: ${error.message}`));
        bonjour.publish({ name: info.hostname, type: "system-bridge", protocol: "tcp", port, txt: { ip: main_address(interfaces) ?? "", port: String(port), uuid: options.uuid() }, disableIPv6: true });
      }
      log(`System Bridge listens on port ${port}`);
      return port;
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const client of clients) client.socket.terminate();
      clients.clear();
      last_sent.clear();
      if (bonjour) await new Promise<void>((resolve) => bonjour!.unpublishAll(() => bonjour!.destroy(() => resolve())));
      bonjour = null;
      sockets?.close();
      sockets = null;
      if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
      http = null;
    },
    clients: () => [...clients].filter((client) => client.authenticated).length,
  };
}
