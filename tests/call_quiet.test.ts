import { describe, expect, test } from "vitest";

import { create_call_quiet, lowered_share } from "../src/server/plugins/call_quiet.ts";
import type { AudioSink, MediaPlayer, SystemServices } from "../src/server/system/services.ts";

// ============================================================================
// Setup
// ============================================================================

function pretend_system(sinks: AudioSink[], players: Pick<MediaPlayer, "name" | "is_playing">[]) {
  const actions: string[] = [];
  const system = {
    volume: {
      list_sinks: async () => sinks.map((sink) => ({ ...sink })),
      set_volume: async (name: string, volume: number) => {
        actions.push(`volume ${name} ${volume}`);
        sinks.find((sink) => sink.name === name)!.volume = volume;
      },
      set_muted: async (name: string, muted: boolean) => {
        actions.push(`muted ${name} ${muted}`);
        sinks.find((sink) => sink.name === name)!.muted = muted;
      },
    },
    media: {
      list_players: async () => players.map((player) => ({ ...player })),
      act: async (name: string, action: string) => {
        actions.push(`${action} ${name}`);
        players.find((player) => player.name === name)!.is_playing = action === "Play";
      },
    },
  } as unknown as Pick<SystemServices, "volume" | "media">;
  return { system, actions };
}

function sink(name: string, volume: number, muted = false, is_default = true): AudioSink {
  return { name, volume, muted, is_default } as AudioSink;
}

const lowered = Math.round(65_536 * lowered_share);

// ============================================================================
// Quieting
// ============================================================================

describe("call quiet", () => {
  test("turns the default speakers down and pauses what plays, then puts both back", async () => {
    const { system, actions } = pretend_system([sink("other", 50_000, false, false), sink("speakers", 60_000)], [{ name: "spotify", is_playing: true }, { name: "mpv", is_playing: false }]);
    const quiet = create_call_quiet(system);

    await quiet.apply({ speakers: "lower", pause: true });
    await quiet.restore();

    expect(actions).toEqual([`Pause spotify`, `volume speakers ${lowered}`, "volume speakers 60000", "Play spotify"]);
  });

  test("mutes for ringing, then unmutes when the answered call only turns them down", async () => {
    const { system, actions } = pretend_system([sink("speakers", 60_000)], []);
    const quiet = create_call_quiet(system);

    await quiet.apply({ speakers: "mute", pause: false });
    await quiet.apply({ speakers: "lower", pause: false });
    await quiet.restore();

    expect(actions).toEqual(["muted speakers true", `volume speakers ${lowered}`, "muted speakers false", "volume speakers 60000"]);
  });

  test("leaves alone what the user changed during the call", async () => {
    const sinks = [sink("speakers", 60_000)];
    const players = [{ name: "spotify", is_playing: true }];
    const { system, actions } = pretend_system(sinks, players);
    const quiet = create_call_quiet(system);

    await quiet.apply({ speakers: "lower", pause: true });
    sinks[0]!.volume = 30_000;
    players[0]!.is_playing = true;
    await quiet.restore();

    expect(actions).toEqual(["Pause spotify", `volume speakers ${lowered}`]);
  });

  test("does nothing to speakers set to nothing, or when there are none", async () => {
    const without_speakers = pretend_system([], []);
    await create_call_quiet(without_speakers.system).apply({ speakers: "lower", pause: false });
    const nothing = pretend_system([sink("speakers", 60_000)], []);
    const quiet = create_call_quiet(nothing.system);

    await quiet.apply({ speakers: "nothing", pause: false });
    await quiet.restore();

    expect(without_speakers.actions).toEqual([]);
    expect(nothing.actions).toEqual([]);
  });

  test("carries on when the players or speakers cannot be read or set", async () => {
    const failing = async () => {
      throw new Error("no sound server");
    };
    const players = [{ name: "spotify", is_playing: true }];
    const reachable = pretend_system([sink("speakers", 60_000)], players);
    const system = {
      volume: { ...reachable.system.volume, set_volume: failing, set_muted: failing },
      media: { ...reachable.system.media, act: failing },
    } as unknown as Pick<SystemServices, "volume" | "media">;
    const quiet = create_call_quiet(system);
    await quiet.apply({ speakers: "nothing", pause: true });
    players[0]!.is_playing = false;
    await quiet.restore();

    const unreadable = create_call_quiet({ volume: { list_sinks: failing }, media: { list_players: failing } } as unknown as Pick<SystemServices, "volume" | "media">);
    await unreadable.apply({ speakers: "lower", pause: true });
    await unreadable.restore();

    let broken = false;
    const speakers = pretend_system([sink("speakers", 60_000)], []);
    const breakable = {
      set_volume: (name: string, volume: number) => (broken ? failing() : speakers.system.volume.set_volume(name, volume)),
      set_muted: (name: string, muted: boolean) => (broken ? failing() : speakers.system.volume.set_muted(name, muted)),
    };
    const unsettable = create_call_quiet({ volume: { ...speakers.system.volume, ...breakable }, media: speakers.system.media } as unknown as Pick<SystemServices, "volume" | "media">);
    await unsettable.apply({ speakers: "lower", pause: false });
    await unsettable.apply({ speakers: "mute", pause: false });
    broken = true;
    await expect(unsettable.restore()).resolves.toBeUndefined();
  });

  test("never turns quiet speakers up", async () => {
    const { system, actions } = pretend_system([sink("speakers", 2_000)], []);
    const quiet = create_call_quiet(system);

    await quiet.apply({ speakers: "lower", pause: false });
    await quiet.restore();

    expect(actions).toEqual(["volume speakers 2000"]);
  });
});
