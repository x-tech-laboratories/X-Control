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

// ── Readings ─────────────────────────────────────────────────────────────────

export interface CpuReading {
  // How busy the processor was since the last reading, from 0 to 100, overall and per core.
  busy: number;
  cores_busy: number[];
  // The load averages over 1, 5 and 15 minutes.
  load: [number, number, number];
  cores: number;
  model: string;
}

export interface MemoryReading {
  total_bytes: number;
  available_bytes: number;
  swap_total_bytes: number;
  swap_free_bytes: number;
}

export interface DiskReading {
  // Where it is mounted, such as "/" or "/home".
  mount: string;
  device: string;
  file_system: string;
  total_bytes: number;
  free_bytes: number;
}

// What a disk has read and written since the computer started, for rates worked out between readings.
export interface DiskCounters {
  device: string;
  read_bytes: number;
  written_bytes: number;
}

export interface NetworkInterface {
  name: string;
  is_up: boolean;
  addresses: string[];
  // Since the computer started.
  received_bytes: number;
  sent_bytes: number;
}

export interface WifiReading {
  interface: string;
  network: string | null;
  signal_dbm: number | null;
}

export interface TemperatureReading {
  // Stable across restarts, such as "k10temp_tctl".
  id: string;
  label: string;
  celsius: number;
}

export interface GpuReading {
  id: string;
  name: string;
  busy: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
}

// Whether a program is using the camera, the microphone or the speakers now.
export interface DevicesInUse {
  camera: boolean;
  microphone: boolean;
  speakers: boolean;
}

export interface ComputerReadings {
  cpu(): Promise<CpuReading>;
  memory(): Promise<MemoryReading>;
  disks(): Promise<DiskReading[]>;
  disk_counters(): Promise<DiskCounters[]>;
  interfaces(): Promise<NetworkInterface[]>;
  // Null without a wireless card.
  wifi(): Promise<WifiReading | null>;
  temperatures(): Promise<TemperatureReading[]>;
  gpus(): Promise<GpuReading[]>;
  // Seconds since the computer started.
  uptime(): Promise<number>;
  // Whether an update waits for a restart to take effect, such as a new kernel.
  restart_needed(): Promise<boolean>;
  user(): string;
  devices_in_use(): Promise<DevicesInUse>;
  // Seconds since the user last touched the keyboard or mouse, or null where the session does not say.
  idle_seconds(): Promise<number | null>;
}

// ── Power ────────────────────────────────────────────────────────────────────

export type PowerAction = "shutdown" | "restart" | "suspend" | "hibernate";

export interface PowerServices {
  act(action: PowerAction): Promise<void>;
  // Null where power-profiles-daemon is not running.
  profiles(): Promise<{ active: string; available: string[] } | null>;
  set_profile(name: string): Promise<void>;
  // The screen's brightness from 0 to 100, or null without a backlight that can be set.
  brightness(): Promise<number | null>;
  set_brightness(percent: number): Promise<void>;
  // Keeps the computer from sleeping or blanking its screen while on.
  keep_awake(on: boolean): Promise<void>;
  is_kept_awake(): boolean;
}

// ── Services ─────────────────────────────────────────────────────────────────

// A systemd unit of the system, or of the user when "user" is true.
export interface UnitServices {
  state(unit: string, user: boolean): Promise<string>;
  set_running(unit: string, user: boolean, running: boolean): Promise<void>;
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
  readings: ComputerReadings;
  power: PowerServices;
  units: UnitServices;
  // Runs a command line the user wrote, as their own shell would.
  run_shell(command: string): Promise<{ exit_code: number; output: string }>;
  // Opens a link or a file in the program the desktop picks.
  open(target: string): Promise<void>;
  // Plays a loud sound so the computer can be found.
  ring(): Promise<void>;
}
