// The services of a Linux desktop, through the programs every desktop ships: wl-clipboard or xclip, playerctl,
// pactl, loginctl and xdg-open. A battery is read from /sys, which Node can do itself.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { not_installed_exit_code, run_program } from "@x-tech-laboratories/x-libs/agent/programs";

import type { AudioSink, BatteryReading, InputServices, MediaPlayer, Modifier, MountServices, SystemServices } from "./services.ts";

// ── Programs ─────────────────────────────────────────────────────────────────

// Runs a program and gives its output, throwing in plain words when it is missing or fails.
async function output_of(argv: string[], stdin: string | null = null): Promise<string> {
  const result = await run_program(argv, { stdin, stdout: "keep", stderr: "keep" });
  if (result.exit_code === not_installed_exit_code) throw new Error(`${argv[0]} is not installed`);
  if (result.exit_code !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.trim() || `exit code ${result.exit_code}`}`);
  return result.stdout;
}

const is_wayland = (): boolean => Boolean(process.env.WAYLAND_DISPLAY);

// ── Battery ──────────────────────────────────────────────────────────────────

const power_supplies = "/sys/class/power_supply";

// The first battery the kernel lists, or null on a computer without one.
export function read_battery(folder = power_supplies): BatteryReading | null {
  if (!existsSync(folder)) return null;
  for (const name of readdirSync(folder)) {
    const read = (file: string): string => {
      try {
        return readFileSync(join(folder, name, file), "utf8").trim();
      } catch {
        return "";
      }
    };
    if (read("type") !== "Battery" || read("present") === "0") continue;
    const charge = Number(read("capacity"));
    if (!Number.isFinite(charge)) continue;
    const status = read("status");
    return { charge, is_charging: status === "Charging" || status === "Full" };
  }
  return null;
}

// ── Media ────────────────────────────────────────────────────────────────────

const metadata_format = "{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{position}}\t{{mpris:length}}\t{{volume}}";

// One player's line of playerctl's metadata, as a player.
export function read_player(name: string, line: string): MediaPlayer {
  const [status = "", title = "", artist = "", album = "", position = "0", length = "0", volume = "1"] = line.replace(/\n$/, "").split("\t");
  return {
    name,
    title,
    artist,
    album,
    is_playing: status === "Playing",
    position: Math.round(Number(position) / 1000) || 0,
    length: Math.round(Number(length) / 1000) || 0,
    volume: Math.round(Number(volume) * 100) || 0,
    can_play: true,
    can_pause: true,
    can_go_next: true,
    can_go_previous: true,
    can_seek: Number(length) > 0,
  };
}

// ── Volume ───────────────────────────────────────────────────────────────────

interface PactlSink {
  name: string;
  description: string;
  mute: boolean;
  volume: Record<string, { value: number }>;
  base_volume?: { value: number };
}

const full_volume = 65536;

// pactl's sinks, with each volume the loudest channel's.
export function read_sinks(json: string, default_sink: string): AudioSink[] {
  return (JSON.parse(json) as PactlSink[]).map((sink) => ({
    name: sink.name,
    description: sink.description,
    volume: Math.max(0, ...Object.values(sink.volume).map((channel) => channel.value)),
    max_volume: full_volume,
    muted: sink.mute,
    is_default: sink.name === default_sink,
  }));
}

// ── Input ────────────────────────────────────────────────────────────────────

const xdotool_buttons = { left: "1", middle: "2", right: "3" };

// xdotool on X11, by key names and button numbers.
function xdotool_input(): InputServices {
  const run = async (...args: string[]): Promise<void> => void (await output_of(["xdotool", ...args]));
  return {
    move: (dx, dy) => run("mousemove_relative", "--", String(Math.round(dx)), String(Math.round(dy))),
    click: (button, how) => {
      const number = xdotool_buttons[button];
      if (how === "press") return run("mousedown", number);
      if (how === "release") return run("mouseup", number);
      return how === "double" ? run("click", "--repeat", "2", number) : run("click", number);
    },
    scroll: async (dx, dy) => {
      const vertical = Math.round(dy);
      const horizontal = Math.round(dx);
      if (vertical) await run("click", "--repeat", String(Math.abs(vertical)), vertical > 0 ? "5" : "4");
      if (horizontal) await run("click", "--repeat", String(Math.abs(horizontal)), horizontal > 0 ? "7" : "6");
    },
    key: (key, modifiers) => run("key", "--clearmodifiers", [...modifiers, key].join("+")),
    type: (text) => run("type", "--clearmodifiers", "--", text),
  };
}

// Linux input key codes, which ydotool presses by number.
export const key_codes: Record<string, number> = {
  BackSpace: 14, Tab: 15, Return: 28, Left: 105, Up: 103, Right: 106, Down: 108, Prior: 104, Next: 109, Home: 102, End: 107,
  Delete: 111, Escape: 1, Sys_Req: 99, Scroll_Lock: 70, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  ctrl: 29, shift: 42, alt: 56, super: 125,
};

// ydotool's key presses for a key with its modifiers held: each pressed in order, then let go in reverse.
export function ydotool_key_presses(key: string, modifiers: Modifier[]): string[] | null {
  const codes = [...modifiers, key].map((name) => key_codes[name]);
  if (codes.some((code) => code === undefined)) return null;
  return [...codes.map((code) => `${code}:1`), ...[...codes].reverse().map((code) => `${code}:0`)];
}

const ydotool_buttons = { left: 0x00, right: 0x01, middle: 0x02 };

// ydotool on Wayland, through its daemon; a key it has no code for is typed as text.
function ydotool_input(): InputServices {
  const run = async (...args: string[]): Promise<void> => void (await output_of(["ydotool", ...args]));
  return {
    move: (dx, dy) => run("mousemove", "-x", String(Math.round(dx)), "-y", String(Math.round(dy))),
    click: (button, how) => {
      const code = ydotool_buttons[button];
      const flags = how === "press" ? 0x40 : how === "release" ? 0x80 : 0xc0;
      return run("click", ...(how === "double" ? ["-r", "2"] : []), `0x${(code | flags).toString(16)}`);
    },
    scroll: (dx, dy) => run("mousemove", "-w", "-x", String(Math.round(dx)), "-y", String(-Math.round(dy))),
    key: async (key, modifiers) => {
      const presses = ydotool_key_presses(key, modifiers);
      await (presses ? run("key", ...presses) : run("type", "--", key));
    },
    type: (text) => run("type", "--", text),
  };
}

// ── Files ────────────────────────────────────────────────────────────────────

// sshfs with the password handed over on stdin, so it never shows in the process list; the phone was already checked over TLS.
function sshfs_mounts(): MountServices {
  return {
    mount: async (share, folder) => {
      mkdirSync(folder, { recursive: true });
      const options = ["password_stdin", "StrictHostKeyChecking=no", "UserKnownHostsFile=/dev/null", "HostKeyAlgorithms=+ssh-rsa", "reconnect", "ServerAliveInterval=15"];
      await output_of(["sshfs", `${share.user}@${share.host}:${share.path}`, folder, "-p", String(share.port), "-o", options.join(",")], `${share.password}\n`);
    },
    unmount: async (folder) => {
      await output_of(["fusermount3", "-u", folder]).catch(() => output_of(["fusermount", "-u", folder]));
    },
  };
}

// ── Services ─────────────────────────────────────────────────────────────────

export function linux_services(): SystemServices {
  return {
    clipboard: {
      read: async () => {
        try {
          return await output_of(is_wayland() ? ["wl-paste", "--no-newline"] : ["xclip", "-selection", "clipboard", "-o"]);
        } catch {
          return null;
        }
      },
      write: async (text) => void (await output_of(is_wayland() ? ["wl-copy"] : ["xclip", "-selection", "clipboard", "-i"], text)),
    },
    battery: async () => read_battery(),
    session: {
      is_locked: async () => {
        const session = process.env.XDG_SESSION_ID;
        if (!session) return false;
        return (await output_of(["loginctl", "show-session", session, "-p", "LockedHint", "--value"])).trim() === "yes";
      },
      lock: async () => void (await output_of(["loginctl", "lock-session"])),
      unlock: async () => void (await output_of(["loginctl", "unlock-session"])),
    },
    media: {
      list_players: async () => {
        const names = (await output_of(["playerctl", "--list-all"]).catch(() => "")).split("\n").filter(Boolean);
        const players = await Promise.all(names.map(async (name) => read_player(name, await output_of(["playerctl", "-p", name, "metadata", "--format", metadata_format]).catch(() => ""))));
        return players;
      },
      act: async (player, action) => {
        const verbs = { Play: "play", Pause: "pause", PlayPause: "play-pause", Stop: "stop", Next: "next", Previous: "previous" };
        await output_of(["playerctl", "-p", player, verbs[action]]);
      },
      set_volume: async (player, volume) => void (await output_of(["playerctl", "-p", player, "volume", String(Math.max(0, Math.min(100, volume)) / 100)])),
      seek: async (player, offset) => void (await output_of(["playerctl", "-p", player, "position", `${Math.abs(offset) / 1000}${offset < 0 ? "-" : "+"}`])),
      set_position: async (player, position) => void (await output_of(["playerctl", "-p", player, "position", String(Math.max(0, position) / 1000)])),
    },
    volume: {
      list_sinks: async () => {
        const [json, default_sink] = await Promise.all([output_of(["pactl", "--format=json", "list", "sinks"]), output_of(["pactl", "get-default-sink"]).catch(() => "")]);
        return read_sinks(json, default_sink.trim());
      },
      set_volume: async (sink, volume) => void (await output_of(["pactl", "set-sink-volume", sink, String(Math.max(0, Math.round(volume)))])),
      set_muted: async (sink, muted) => void (await output_of(["pactl", "set-sink-mute", sink, muted ? "1" : "0"])),
      make_default: async (sink) => void (await output_of(["pactl", "set-default-sink", sink])),
    },
    input: is_wayland() ? ydotool_input() : xdotool_input(),
    files: sshfs_mounts(),
    run_shell: async (command) => {
      const result = await run_program(["sh", "-c", command], { stdout: "keep", stderr: "keep" });
      return { exit_code: result.exit_code, output: (result.stdout + result.stderr).trim() };
    },
    open: async (target) => void (await output_of(["xdg-open", target])),
    ring: async () => void (await output_of(["canberra-gtk-play", "-i", "phone-incoming-call", "-d", "X-Control"])),
  };
}
