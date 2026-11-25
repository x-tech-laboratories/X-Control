// What each bundled plugin knows of a device, as the page reads it under the device's plugins, such as plugins.battery.

export interface BatteryState {
  // From 0 to 100, or -1 for a device without a battery.
  charge: number;
  is_charging: boolean;
}

export interface SignalState {
  // By SIM, such as { "1": { network: "4G", strength: 3 } }, strength from 0 to 4.
  signals: Record<string, { network: string; strength: number }>;
}

export interface CallState {
  // The call under way, or null when there is none.
  call: { event: "ringing" | "talking"; caller: string } | null;
}

export interface PhoneNotification {
  id: string;
  app: string;
  title: string;
  text: string;
  // In milliseconds since 1970.
  time: number;
  is_clearable: boolean;
  actions: string[];
  // Set when the notification can be answered, such as a chat message.
  reply_id: string | null;
}

export interface NotificationState {
  notifications: PhoneNotification[];
}

export interface Shared {
  kind: "file" | "url" | "text";
  // The file's path here, the link or the text.
  value: string;
  // In milliseconds since 1970.
  at: number;
}

export interface ShareState {
  received: Shared[];
}

export interface RemoteCommandState {
  // The device's own commands, which this computer can ask it to run.
  commands: { key: string; name: string; command: string }[];
}

export interface LockState {
  is_locked: boolean;
}

export interface RemotePlayer {
  name: string;
  title: string;
  artist: string;
  album: string;
  is_playing: boolean;
  // In milliseconds.
  position: number;
  length: number;
  volume: number;
}

export interface MediaState {
  players: RemotePlayer[];
}

export interface RemoteSink {
  name: string;
  description: string;
  volume: number;
  max_volume: number;
  muted: boolean;
  enabled: boolean;
}

export interface VolumeState {
  sinks: RemoteSink[];
}
