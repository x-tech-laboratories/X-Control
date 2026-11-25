// Media players: this computer's players controlled from a device, with what plays sent back as it changes, and a
// device's own players controlled from the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { mpris_manifest } from "../../shared/plugins/manifests.ts";
import type { MediaAction, MediaPlayer } from "../system/services.ts";
import type { RemotePlayer, MediaState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi, DeviceHandle } from "./api.ts";
import { connected_devices, number_field, text_arg, text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const mpris_type = "kdeconnect.mpris";
const request_type = "kdeconnect.mpris.request";
const watch_interval_in_milliseconds = 3000;
const media_actions: MediaAction[] = ["Play", "Pause", "PlayPause", "Stop", "Next", "Previous"];

// A local player as KDE Connect describes it.
export function player_body(player: MediaPlayer): Record<string, unknown> {
  const now_playing = [player.artist, player.title].filter(Boolean).join(" - ");
  return {
    player: player.name,
    title: player.title,
    artist: player.artist,
    album: player.album,
    nowPlaying: now_playing,
    isPlaying: player.is_playing,
    pos: player.position,
    length: player.length,
    volume: player.volume,
    canPause: player.can_pause,
    canPlay: player.can_play,
    canGoNext: player.can_go_next,
    canGoPrevious: player.can_go_previous,
    canSeek: player.can_seek,
  };
}

// What a device's player is doing, laid over what was known of it, since a packet may carry only some fields.
export function merge_remote_player(known: RemotePlayer | undefined, body: Record<string, unknown>): RemotePlayer {
  const base: RemotePlayer = known ?? { name: text_field(body, "player"), title: "", artist: "", album: "", is_playing: false, position: 0, length: 0, volume: 100 };
  return {
    name: base.name,
    title: "title" in body ? text_field(body, "title") : base.title,
    artist: "artist" in body ? text_field(body, "artist") : base.artist,
    album: "album" in body ? text_field(body, "album") : base.album,
    is_playing: "isPlaying" in body ? body.isPlaying === true : base.is_playing,
    position: "pos" in body ? number_field(body, "pos") : base.position,
    length: "length" in body ? number_field(body, "length") : base.length,
    volume: "volume" in body ? number_field(body, "volume", 100) : base.volume,
  };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const mpris_plugin = define_plugin<ControlPluginApi>({
  ...mpris_manifest,
  start(context) {
    const devices = connected_devices();
    const { media } = context.services.system;
    let last_sent = new Map<string, string>();

    const send_players = async (targets: DeviceHandle[], players?: MediaPlayer[]): Promise<void> => {
      const found = players ?? (await media.list_players());
      await Promise.all(
        targets
          .filter((device) => device.takes(mpris_type))
          .map(async (device) => {
            await device.send(mpris_type, { playerList: found.map((player) => player.name), supportAlbumArtPayload: false });
            for (const player of found) await device.send(mpris_type, player_body(player));
          }),
      ).catch(() => undefined);
    };

    // Players are polled while a device listens, and only what changed is sent.
    const timer = setInterval(async () => {
      const listening = devices.all().filter((device) => device.takes(mpris_type));
      if (listening.length === 0) return;
      const players = await media.list_players().catch(() => [] as MediaPlayer[]);
      const now = new Map(players.map((player) => [player.name, JSON.stringify(player_body(player))]));
      const list_changed = [...now.keys()].join("\n") !== [...last_sent.keys()].join("\n");
      const changed = players.filter((player) => last_sent.get(player.name) !== now.get(player.name));
      last_sent = now;
      for (const device of listening) {
        if (list_changed) await device.send(mpris_type, { playerList: players.map((player) => player.name), supportAlbumArtPayload: false }).catch(() => undefined);
        for (const player of changed) await device.send(mpris_type, player_body(player)).catch(() => undefined);
      }
    }, watch_interval_in_milliseconds);
    context.on_stop(() => clearInterval(timer));

    const answer = async (device: DeviceHandle, body: Record<string, unknown>): Promise<void> => {
      if (body.requestPlayerList === true) return send_players([device]);
      const name = text_field(body, "player");
      if (!name) return;
      const action = text_field(body, "action") as MediaAction;
      if (media_actions.includes(action)) await media.act(name, action);
      if (typeof body.setVolume === "number") await media.set_volume(name, body.setVolume);
      // Seek is an offset in microseconds; SetPosition a position in milliseconds.
      if (typeof body.Seek === "number") await media.seek(name, Math.round(body.Seek / 1000));
      if (typeof body.SetPosition === "number") await media.set_position(name, body.SetPosition);
      const player = (await media.list_players()).find((candidate) => candidate.name === name);
      if (player && device.takes(mpris_type)) await device.send(mpris_type, player_body(player));
    };

    const remember = (device: DeviceHandle, body: Record<string, unknown>): void => {
      const known = device.state<MediaState>()?.players ?? [];
      if (Array.isArray(body.playerList)) {
        const names = body.playerList.filter((name): name is string => typeof name === "string");
        const players = names.map((name) => known.find((player) => player.name === name) ?? merge_remote_player(undefined, { player: name }));
        device.set_state({ players } satisfies MediaState);
        for (const name of names) if (device.takes(request_type)) void device.send(request_type, { player: name, requestNowPlaying: true, requestVolume: true }).catch(() => undefined);
        return;
      }
      const name = text_field(body, "player");
      if (!name) return;
      const others = known.filter((player) => player.name !== name);
      device.set_state({ players: [...others, merge_remote_player(known.find((player) => player.name === name), body)].sort((first, second) => first.name.localeCompare(second.name)) } satisfies MediaState);
    };

    const player_arg = { name: "player", schema: { type: "string", description: "The player's name, from the device's players." } };

    context.provide("capability", "mpris", {
      incoming: [mpris_type, request_type],
      outgoing: [mpris_type, request_type],
      async connected(device) {
        devices.add(device);
        if (device.takes(request_type)) await device.send(request_type, { requestPlayerList: true });
        await send_players([device]);
      },
      disconnected: devices.remove,
      packet: (device, packet) => (packet.type === request_type ? answer(device, packet.body) : remember(device, packet.body)),
      actions: {
        act: {
          label: "Control a player",
          description: "Plays, pauses or skips on one of the device's media players.",
          params: [player_arg, { name: "action", schema: { type: "string", enum: media_actions, description: "What to do." } }],
          needs: request_type,
          run: (device, args) => {
            const action = text_arg(args, "action") as MediaAction;
            if (!media_actions.includes(action)) throw new Error(`The action is one of ${media_actions.join(", ")}.`);
            return device.send(request_type, { player: text_arg(args, "player"), action });
          },
        },
        volume: {
          label: "Set a player's volume",
          description: "Sets one of the device's media players' volume.",
          params: [player_arg, { name: "volume", schema: { type: "number", minimum: 0, maximum: 100, description: "From 0 to 100." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { player: text_arg(args, "player"), setVolume: Math.round(Number(args.volume)) }),
        },
        seek: {
          label: "Seek",
          description: "Moves one of the device's media players to a position.",
          params: [player_arg, { name: "position", schema: { type: "number", minimum: 0, description: "Where to go, in milliseconds." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { player: text_arg(args, "player"), SetPosition: Math.round(Number(args.position)) }),
        },
      },
    });
  },
});
