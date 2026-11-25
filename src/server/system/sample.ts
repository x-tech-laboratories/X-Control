// A computer kept in memory, for tests and for the dev server's sample data, so neither touches the real desktop: a
// clipboard, a battery, two media players and two speakers, and a log of what was asked of it.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AudioSink, MediaPlayer, SystemServices } from "./services.ts";

// ── Sample computer ──────────────────────────────────────────────────────────

export interface SampleComputer extends SystemServices {
  // Everything asked of it, such as "lock" or "run echo hi", in order.
  done: string[];
  state: { clipboard: string; locked: boolean; players: MediaPlayer[]; sinks: AudioSink[] };
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
  };
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
    run_shell: async (command) => {
      done.push(`run ${command}`);
      return { exit_code: 0, output: "" };
    },
    open: async (target) => void done.push(`open ${target}`),
    ring: async () => void done.push("ring"),
  };
}
