// What X-Control's plugins ask of the computer the daemon runs on, such as its clipboard, its battery or its media
// players, so a plugin never talks to the desktop itself and tests can hand in a computer of their own.

// ── Media ────────────────────────────────────────────────────────────────────

export interface MediaPlayer {
  // The player's own name, such as "firefox" or "spotify".
  name: string;
  title: string;
  artist: string;
  album: string;
  is_playing: boolean;
  // In milliseconds.
  position: number;
  length: number;
  // From 0 to 100.
  volume: number;
  can_play: boolean;
  can_pause: boolean;
  can_go_next: boolean;
  can_go_previous: boolean;
  can_seek: boolean;
}

export type MediaAction = "Play" | "Pause" | "PlayPause" | "Stop" | "Next" | "Previous";

export interface MediaServices {
  list_players(): Promise<MediaPlayer[]>;
  act(player: string, action: MediaAction): Promise<void>;
  set_volume(player: string, volume: number): Promise<void>;
  // Moves by an offset, or to a position, in milliseconds.
  seek(player: string, offset: number): Promise<void>;
  set_position(player: string, position: number): Promise<void>;
}

// ── Volume ───────────────────────────────────────────────────────────────────

export interface AudioSink {
  name: string;
  description: string;
  // From 0 to max_volume.
  volume: number;
  max_volume: number;
  muted: boolean;
  is_default: boolean;
}

export interface VolumeServices {
  list_sinks(): Promise<AudioSink[]>;
  set_volume(sink: string, volume: number): Promise<void>;
  set_muted(sink: string, muted: boolean): Promise<void>;
  make_default(sink: string): Promise<void>;
}

// ── Computer ─────────────────────────────────────────────────────────────────

export interface BatteryReading {
  // From 0 to 100.
  charge: number;
  is_charging: boolean;
}

export interface SystemServices {
  clipboard: {
    read(): Promise<string | null>;
    write(text: string): Promise<void>;
  };
  // Null on a computer without a battery.
  battery(): Promise<BatteryReading | null>;
  session: {
    is_locked(): Promise<boolean>;
    lock(): Promise<void>;
    unlock(): Promise<void>;
  };
  media: MediaServices;
  volume: VolumeServices;
  // Runs a command line the user wrote, as their own shell would.
  run_shell(command: string): Promise<{ exit_code: number; output: string }>;
  // Opens a link or a file in the program the desktop picks.
  open(target: string): Promise<void>;
  // Plays a loud sound so the computer can be found.
  ring(): Promise<void>;
}
