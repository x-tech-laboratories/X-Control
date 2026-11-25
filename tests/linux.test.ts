import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { read_battery, read_player, read_sinks } from "../src/server/system/linux.ts";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })));

function supplies(entries: Record<string, Record<string, string>>): string {
  const folder = mkdtempSync(join(tmpdir(), "x-control-power-"));
  folders.push(folder);
  for (const [name, files] of Object.entries(entries)) {
    mkdirSync(join(folder, name));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, name, file), `${text}\n`);
  }
  return folder;
}

describe("the Linux desktop", () => {
  test("reads the first battery, skipping mains power", () => {
    const folder = supplies({ AC: { type: "Mains", online: "1" }, BAT0: { type: "Battery", capacity: "57", status: "Charging" } });
    expect(read_battery(folder)).toEqual({ charge: 57, is_charging: true });
  });

  test("has no battery when none is listed", () => {
    expect(read_battery(supplies({ AC: { type: "Mains" } }))).toBeNull();
    expect(read_battery("/no/such/folder")).toBeNull();
  });

  test("reads a player from playerctl's metadata", () => {
    const player = read_player("spotify", "Playing\tSong\tArtist\tAlbum\t30000000\t215000000\t0.5\n");
    expect(player).toMatchObject({ name: "spotify", title: "Song", is_playing: true, position: 30000, length: 215000, volume: 50, can_seek: true });
  });

  test("reads pactl's sinks with the loudest channel's volume", () => {
    const json = JSON.stringify([{ name: "out", description: "Speakers", mute: false, volume: { "front-left": { value: 30000 }, "front-right": { value: 32000 } } }]);
    expect(read_sinks(json, "out")).toEqual([{ name: "out", description: "Speakers", volume: 32000, max_volume: 65536, muted: false, is_default: true }]);
  });
});
