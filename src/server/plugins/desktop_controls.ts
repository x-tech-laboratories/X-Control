// Desktop controls: a notification shown on this computer, a link or file opened, text typed or put on the
// clipboard, the media playing and the speakers, as LNXlink's notify, xdg open, keyboard, clipboard, media and audio
// select modules offer them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { desktop_controls_manifest } from "../../shared/plugins/manifests.ts";
import type { MediaPlayer } from "../system/services.ts";
import type { ControlPluginApi, Entity } from "./api.ts";
import { shared_reading } from "./helpers.ts";

// PulseAudio's volume at 100 %.
const full_volume = 65_536;

// ── Messages ─────────────────────────────────────────────────────────────────

// A notification's title and text: JSON with title and message, as Home Assistant's notify sends it, or plain text.
export function read_message(text: string): { title: string; body: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      const body = typeof fields.message === "string" ? fields.message : typeof fields.body === "string" ? fields.body : "";
      if (body) return { title: typeof fields.title === "string" && fields.title ? fields.title : "Home Assistant", body };
    }
  } catch {
    // Plain text.
  }
  return { title: "Home Assistant", body: text };
}

// The player a media control acts on: the one playing, or else the first.
export function main_player(players: MediaPlayer[]): MediaPlayer | null {
  return players.find((player) => player.is_playing) ?? players[0] ?? null;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const desktop_controls_plugin = define_plugin<ControlPluginApi>({
  ...desktop_controls_manifest,
  start(context) {
    const { system } = context.services;
    const players = shared_reading(() => system.media.list_players());
    const sinks = shared_reading(() => system.volume.list_sinks());
    const default_sink = async () => {
      const found = (await sinks()).find((sink) => sink.is_default) ?? (await sinks())[0];
      if (!found) throw new Error("This computer has no speakers.");
      return found;
    };
    const act = (action: "PlayPause" | "Next" | "Previous") => async () => {
      const player = main_player(await players());
      if (!player) throw new Error("No media player is open.");
      await system.media.act(player.name, action);
      players.forget();
    };
    let message_count = 0;

    context.provide("entities", "desktop", {
      async list() {
        const entities: Entity[] = [
          {
            id: "notify",
            name: "Send a notification",
            kind: "text",
            icon: "mdi:message-badge",
            set: (text) => {
              const message = read_message(String(text ?? ""));
              if (!message.body) return;
              context.services.notify({ kind: "remote_message", key: `remote_message:${++message_count}`, ...message });
            },
          },
          { id: "open", name: "Open a link or file", kind: "text", icon: "mdi:open-in-new", set: (target) => (target ? system.open(String(target)) : undefined) },
          { id: "type", name: "Type text", kind: "text", icon: "mdi:keyboard", set: (text) => (text ? system.input.type(String(text)) : undefined) },
          {
            id: "clipboard",
            name: "Clipboard",
            kind: "text",
            icon: "mdi:clipboard-text",
            every: 5,
            read: async () => (context.settings().publish_clipboard === true ? ((await system.clipboard.read()) ?? "").slice(0, 255) : null),
            set: (text) => system.clipboard.write(String(text ?? "")),
          },
          {
            id: "media",
            name: "Media",
            kind: "sensor",
            icon: "mdi:music",
            read: async () => {
              const player = main_player(await players());
              if (!player) return { value: "Nothing open", attributes: {} };
              const title = [player.title, player.artist].filter(Boolean).join(" · ") || player.name;
              return { value: title.slice(0, 255), attributes: { player: player.name, playing: player.is_playing, title: player.title, artist: player.artist, album: player.album, position_seconds: Math.round(player.position / 1000), length_seconds: Math.round(player.length / 1000) } };
            },
          },
          { id: "play_pause", name: "Play or pause", kind: "button", icon: "mdi:play-pause", set: act("PlayPause") },
          { id: "next", name: "Next track", kind: "button", icon: "mdi:skip-next", set: act("Next") },
          { id: "previous", name: "Previous track", kind: "button", icon: "mdi:skip-previous", set: act("Previous") },
        ];
        const outputs = await sinks().catch(() => []);
        if (outputs.length > 0) {
          entities.push(
            {
              id: "volume",
              name: "Volume",
              kind: "number",
              icon: "mdi:volume-high",
              unit: "%",
              min: 0,
              max: 100,
              step: 1,
              read: async () => Math.round(((await default_sink()).volume / full_volume) * 100),
              set: async (percent) => {
                await system.volume.set_volume((await default_sink()).name, Math.round((Number(percent) / 100) * full_volume));
                sinks.forget();
              },
            },
            {
              id: "muted",
              name: "Muted",
              kind: "switch",
              icon: "mdi:volume-off",
              read: async () => (await default_sink()).muted,
              set: async (muted) => {
                await system.volume.set_muted((await default_sink()).name, muted === true);
                sinks.forget();
              },
            },
            {
              id: "output",
              name: "Sound output",
              kind: "select",
              icon: "mdi:speaker-multiple",
              options: outputs.map((sink) => sink.description),
              read: async () => (await default_sink()).description,
              set: async (description) => {
                const sink = (await sinks()).find((entry) => entry.description === description);
                if (!sink) throw new Error(`No sound output called ${String(description)}.`);
                await system.volume.make_default(sink.name);
                sinks.forget();
              },
            },
          );
        }
        return entities;
      },
    });
  },
});
