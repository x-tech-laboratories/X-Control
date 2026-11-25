// A computer kept in memory, for tests and for the dev server's sample data, so neither touches the real desktop: a
// clipboard, a battery, two media players and two speakers, readings that drift as a busy computer's do, and a log of
// what was asked of it.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AudioSink, MediaPlayer, SystemServices } from "./services.ts";

// ── Sample computer ──────────────────────────────────────────────────────────

export interface SampleComputer extends SystemServices {
  // Everything asked of it, such as "lock" or "run echo hi", in order.
  done: string[];
  state: { clipboard: string; locked: boolean; players: MediaPlayer[]; sinks: AudioSink[]; profile: string; brightness: number; kept_awake: boolean; units: Record<string, boolean> };
}

const gib = 1024 ** 3;

// A value that drifts between two bounds as time passes, so the sample's readings move.
function drift(low: number, high: number, period_seconds: number, offset = 0): number {
  const phase = (Date.now() / 1000 / period_seconds + offset) * Math.PI * 2;
  return Math.round((low + ((Math.sin(phase) + 1) / 2) * (high - low)) * 10) / 10;
}

// Counters that grow by about the rate given each second, as a disk's or network card's do.
function counter(rate_per_second: number, started = Date.now()): () => number {
  return () => Math.round(((Date.now() - started) / 1000) * rate_per_second * (1 + Math.sin(Date.now() / 7000) / 2));
}

function player(name: string, title: string, artist: string, is_playing: boolean): MediaPlayer {
  return { name, title, artist, album: "", is_playing, position: 30_000, length: 215_000, volume: 70, can_play: true, can_pause: true, can_go_next: true, can_go_previous: true, can_seek: true };
}

export function sample_computer(): SampleComputer {
  const state = {
    clipboard: "",
    locked: false,
    players: [player("music", "Sample Song", "Sample Artist", true), player("video", "Sample Film", "", false)],
    sinks: [
      { name: "speakers", description: "Speakers", volume: 40_000, max_volume: 65_536, muted: false, is_default: true },
      { name: "headphones", description: "Headphones", volume: 20_000, max_volume: 65_536, muted: true, is_default: false },
    ] as AudioSink[],
    profile: "balanced",
    brightness: 70,
    kept_awake: false,
    units: { "backup.service": false, "syncthing.service": true } as Record<string, boolean>,
  };
  const disk_read = counter(4_000_000);
  const disk_written = counter(1_500_000);
  const received = counter(800_000);
  const sent = counter(120_000);
  const done: string[] = [];
  const find_player = (name: string): MediaPlayer => {
    const found = state.players.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no player called ${name}`);
    return found;
  };
  const find_sink = (name: string): AudioSink => {
    const found = state.sinks.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no speaker called ${name}`);
    return found;
  };
  return {
    done,
    state,
    clipboard: {
      read: async () => state.clipboard,
      write: async (text) => {
        state.clipboard = text;
        done.push(`clipboard ${text}`);
      },
    },
    battery: async () => ({ charge: 64, is_charging: false }),
    session: {
      is_locked: async () => state.locked,
      lock: async () => void ((state.locked = true), done.push("lock")),
      unlock: async () => void ((state.locked = false), done.push("unlock")),
    },
    media: {
      list_players: async () => state.players.map((entry) => ({ ...entry })),
      act: async (name, action) => {
        const found = find_player(name);
        if (action === "Play") found.is_playing = true;
        if (action === "Pause" || action === "Stop") found.is_playing = false;
        if (action === "PlayPause") found.is_playing = !found.is_playing;
        done.push(`media ${name} ${action}`);
      },
      set_volume: async (name, volume) => void (find_player(name).volume = volume),
      seek: async (name, offset) => void (find_player(name).position += offset),
      set_position: async (name, position) => void (find_player(name).position = position),
    },
    volume: {
      list_sinks: async () => state.sinks.map((sink) => ({ ...sink })),
      set_volume: async (name, volume) => void (find_sink(name).volume = volume),
      set_muted: async (name, muted) => void (find_sink(name).muted = muted),
      make_default: async (name) => {
        for (const sink of state.sinks) sink.is_default = sink.name === name;
      },
    },
    input: {
      move: async (dx, dy) => void done.push(`move ${dx} ${dy}`),
      click: async (button, how) => void done.push(`click ${button} ${how}`),
      scroll: async (dx, dy) => void done.push(`scroll ${dx} ${dy}`),
      key: async (key, modifiers) => void done.push(`key ${[...modifiers, key].join("+")}`),
      type: async (text) => void done.push(`type ${text}`),
    },
    files: {
      mount: async (share, folder) => void done.push(`mount ${share.user}@${share.host}:${share.port}${share.path} on ${folder}`),
      unmount: async (folder) => void done.push(`unmount ${folder}`),
    },
    readings: {
      cpu: async () => {
        const busy = drift(8, 64, 40);
        return { busy, cores_busy: [busy, drift(4, 80, 30, 0.3), drift(2, 50, 50, 0.6), drift(10, 70, 35, 0.9)], load: [drift(0.3, 2.4, 60), 1.1, 0.9], cores: 4, model: "Sample Processor 4-Core" };
      },
      memory: async () => ({ total_bytes: 16 * gib, available_bytes: Math.round(drift(5, 9, 90) * gib), swap_total_bytes: 8 * gib, swap_free_bytes: 7 * gib }),
      disks: async () => [
        { mount: "/", device: "/dev/sample1", file_system: "ext4", total_bytes: 500 * gib, free_bytes: 212 * gib },
        { mount: "/home", device: "/dev/sample2", file_system: "btrfs", total_bytes: 1000 * gib, free_bytes: 386 * gib },
      ],
      disk_counters: async () => [{ device: "sample", read_bytes: disk_read(), written_bytes: disk_written() }],
      interfaces: async () => [
        { name: "eth0", is_up: true, addresses: ["192.168.1.40", "fe80::1"], received_bytes: received(), sent_bytes: sent() },
        { name: "wlan0", is_up: false, addresses: [], received_bytes: 0, sent_bytes: 0 },
      ],
      wifi: async () => ({ interface: "wlan0", network: "Sample Network", signal_dbm: Math.round(drift(-70, -45, 80)) }),
      temperatures: async () => [
        { id: "cpu_package", label: "Processor package", celsius: drift(41, 68, 45) },
        { id: "nvme_composite", label: "nvme Composite", celsius: drift(33, 39, 120) },
      ],
      gpus: async () => [{ id: "card0", name: "sample", busy: drift(0, 35, 25), memory_used_bytes: 1.2 * gib, memory_total_bytes: 4 * gib }],
      uptime: async () => Math.round(3 * 86_400 + process.uptime()),
      restart_needed: async () => false,
      user: () => "sample",
      devices_in_use: async () => ({ camera: false, microphone: false, speakers: state.players.some((entry) => entry.is_playing) }),
      idle_seconds: async () => 0,
    },
    power: {
      act: async (action) => void done.push(`power ${action}`),
      profiles: async () => ({ active: state.profile, available: ["power-saver", "balanced", "performance"] }),
      set_profile: async (name) => {
        if (!["power-saver", "balanced", "performance"].includes(name)) throw new Error(`no power profile called ${name}`);
        state.profile = name;
      },
      brightness: async () => state.brightness,
      set_brightness: async (percent) => void (state.brightness = Math.max(1, Math.min(100, Math.round(percent)))),
      keep_awake: async (on) => void (state.kept_awake = on),
      is_kept_awake: () => state.kept_awake,
    },
    units: {
      state: async (unit) => (unit in state.units ? (state.units[unit] ? "active" : "inactive") : "unknown"),
      set_running: async (unit, _user, running) => {
        state.units[unit] = running;
        done.push(`${running ? "start" : "stop"} ${unit}`);
      },
    },
    run_shell: async (command) => {
      done.push(`run ${command}`);
      return { exit_code: 0, output: "" };
    },
    open: async (target) => void done.push(`open ${target}`),
    ring: async () => void done.push("ring"),
  };
}
