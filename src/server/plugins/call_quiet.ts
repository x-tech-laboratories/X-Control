// This computer kept quiet while a phone rings or a call is under way, as Valent's telephony plugin does: the
// speakers turned down or muted and the players paused, then put back as they were once the call ends, unless the
// user changed them in between.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SystemServices } from "../system/services.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export type SpeakerChoice = "nothing" | "lower" | "mute";

export interface QuietSettings {
  speakers: SpeakerChoice;
  pause: boolean;
}

// How loud turned-down speakers are, as a share of full volume.
export const lowered_share = 0.15;

const full_volume = 65_536;

// ── Quiet ────────────────────────────────────────────────────────────────────

interface Kept {
  sink: string;
  volume: number;
  muted: boolean;
  // What this set, so a change the user made since is left alone.
  set_volume: number;
  set_muted: boolean;
}

export interface CallQuiet {
  // Quiets the computer as the settings say for a call in this state; a later call state replaces an earlier one.
  apply(settings: QuietSettings): Promise<void>;
  // Puts back what was changed.
  restore(): Promise<void>;
}

export function create_call_quiet(system: Pick<SystemServices, "volume" | "media">): CallQuiet {
  let kept: Kept | null = null;
  const paused = new Set<string>();

  return {
    async apply(settings) {
      if (settings.pause) {
        for (const player of await system.media.list_players().catch(() => [])) {
          if (!player.is_playing) continue;
          await system.media.act(player.name, "Pause").catch(() => undefined);
          paused.add(player.name);
        }
      }
      if (settings.speakers === "nothing") return;
      const sinks = await system.volume.list_sinks().catch(() => []);
      const sink = sinks.find((entry) => entry.is_default) ?? sinks[0];
      if (!sink) return;
      // The speakers as they were before the call, kept from the first change.
      kept ??= { sink: sink.name, volume: sink.volume, muted: sink.muted, set_volume: sink.volume, set_muted: sink.muted };
      if (settings.speakers === "mute") {
        await system.volume.set_muted(sink.name, true);
        kept.set_muted = true;
      } else {
        const lowered = Math.min(kept.volume, Math.round(full_volume * lowered_share));
        await system.volume.set_volume(sink.name, lowered);
        kept.set_volume = lowered;
        // Turned down rather than muted, so a mute from ringing is lifted when the call is answered.
        if (sink.muted && !kept.muted) {
          await system.volume.set_muted(sink.name, false);
          kept.set_muted = false;
        }
      }
    },
    async restore() {
      const was = kept;
      kept = null;
      if (was) {
        const sink = (await system.volume.list_sinks().catch(() => [])).find((entry) => entry.name === was.sink);
        if (sink) {
          if (sink.volume === was.set_volume && was.set_volume !== was.volume) await system.volume.set_volume(sink.name, was.volume).catch(() => undefined);
          if (sink.muted === was.set_muted && was.set_muted !== was.muted) await system.volume.set_muted(sink.name, was.muted).catch(() => undefined);
        }
      }
      const players = [...paused];
      paused.clear();
      const playing = new Map((await system.media.list_players().catch(() => [])).map((player) => [player.name, player.is_playing]));
      // Only players still paused are played again; one the user started or closed is left alone.
      for (const name of players) if (playing.get(name) === false) await system.media.act(name, "Play").catch(() => undefined);
    },
  };
}
