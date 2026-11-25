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

// ── Input ────────────────────────────────────────────────────────────────────

// Keys a device can press by name, as X11 names them; anything else is typed as text.
export const special_keys = ["BackSpace", "Tab", "Return", "Left", "Up", "Right", "Down", "Prior", "Next", "Home", "End", "Delete", "Escape", "Sys_Req", "Scroll_Lock", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"] as const;

export type SpecialKey = (typeof special_keys)[number];

export type Modifier = "ctrl" | "alt" | "shift" | "super";

export type MouseButton = "left" | "middle" | "right";

// The pointer and keyboard of the computer, driven by a device used as its touchpad and keyboard.
export interface InputServices {
  move(dx: number, dy: number): Promise<void>;
  // "double" clicks twice; "press" and "release" hold the button and let it go, for dragging.
  click(button: MouseButton, how: "click" | "double" | "press" | "release"): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  key(key: SpecialKey | string, modifiers: Modifier[]): Promise<void>;
  type(text: string): Promise<void>;
}

// ── Files ────────────────────────────────────────────────────────────────────

// Where a phone serves its files over SFTP; the password is one the phone made for this time only.
export interface SftpShare {
  host: string;
  port: number;
  user: string;
  password: string;
  path: string;
}

export interface MountServices {
  // Mounts the share on the folder given, which is made first.
  mount(share: SftpShare, folder: string): Promise<void>;
  unmount(folder: string): Promise<void>;
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
  input: InputServices;
  files: MountServices;
  // Runs a command line the user wrote, as their own shell would.
  run_shell(command: string): Promise<{ exit_code: number; output: string }>;
  // Opens a link or a file in the program the desktop picks.
  open(target: string): Promise<void>;
  // Plays a loud sound so the computer can be found.
  ring(): Promise<void>;
}
