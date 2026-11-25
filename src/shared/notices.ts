// The kinds of things X-Control tells its user while the page is not in front of them, each with a switch in Settings.

// ── Kinds ────────────────────────────────────────────────────────────────────

export const notice_kinds = [
  { kind: "pair_request", label: "Pairing requests", hint: "A device asks to pair with this one." },
  { kind: "ping", label: "Pings", hint: "A device pings this one." },
  { kind: "phone_notification", label: "Phone notifications", hint: "Notifications from a paired phone, shown here as well." },
  { kind: "call", label: "Calls", hint: "A paired phone rings or misses a call." },
  { kind: "battery_low", label: "Low battery", hint: "A paired device's battery runs low." },
  { kind: "file_received", label: "Files and links received", hint: "A device shares a file, a link or text with this one." },
  { kind: "find_my_device", label: "Find my device", hint: "A device rings this one to find it." },
  { kind: "remote_message", label: "Messages from Home Assistant", hint: "Home Assistant sends this computer a notification." },
] as const;

export type NoticeKind = (typeof notice_kinds)[number]["kind"];

export interface Notice {
  kind: NoticeKind;
  // A newer notice with the same key replaces the older one.
  key: string;
  title: string;
  body: string;
  // The page's route the notice opens, such as "#/devices/<id>".
  route?: string;
  urgency?: "low" | "normal" | "critical";
}

// The setting that holds whether a kind is on, kept on each device rather than synced.
export function notice_setting(kind: NoticeKind): string {
  return `notify.${kind}`;
}

export const notice_setting_defaults: Record<string, boolean> = Object.fromEntries(notice_kinds.map((entry) => [notice_setting(entry.kind), true]));
