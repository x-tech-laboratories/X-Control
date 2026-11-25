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

export interface Contact {
  uid: string;
  name: string;
  // Phone numbers as the contact holds them, such as "+44 20 7946 0000".
  phones: string[];
}

export interface ContactsState {
  contacts: Contact[];
}

export interface TextMessage {
  id: number;
  thread_id: number;
  // The other people in the conversation, by number.
  addresses: string[];
  body: string;
  // In milliseconds since 1970.
  date: number;
  // Whether the phone's owner sent it rather than received it.
  is_sent: boolean;
  is_read: boolean;
}

export interface Conversation {
  thread_id: number;
  addresses: string[];
  // The newest message first.
  messages: TextMessage[];
}

export interface SmsState {
  conversations: Conversation[];
}

export interface SftpState {
  // Where the phone's files are mounted on this computer, or null while they are not.
  folder: string | null;
  // The phone's storage places, such as Internal storage and an SD card, each as a folder under the mount.
  places: { name: string; path: string }[];
  error: string | null;
}

export interface InputState {
  // Whether the device's keyboard is ready to take keys typed from here.
  keyboard_ready: boolean;
}
