// X-Control as the plugin host knows it, and the manifest of every bundled plugin: the daemon's side and the page's
// side of a plugin share one manifest, so turning it off in Settings stops both.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AppInfo, PluginManifest } from "@x-tech-laboratories/x-libs/plugins";

import package_json from "../../../package.json" with { type: "json" };

// ── App ──────────────────────────────────────────────────────────────────────

export const app_info: AppInfo = { id: "x-control", version: package_json.version };

// The setting holding every plugin's on or off and its own settings.
export const plugins_setting = "plugins";

function bundled(id: string, name: string, description: string, settings: PluginManifest["settings"] = []): PluginManifest {
  return { id, name, version: package_json.version, description, app: app_info.id, settings };
}

// ── Bundled plugins ──────────────────────────────────────────────────────────

export const ping_manifest = bundled("ping", "Ping", "Send and receive pings, to check a device is there.");

export const battery_manifest = bundled("battery", "Battery", "See a device's battery, and share this computer's.", [
  { key: "low_level", label: "Low battery at", hint: "Warn when a device's battery falls to this percentage.", type: "number", default: 15 },
]);

export const clipboard_manifest = bundled("clipboard", "Clipboard", "Keep the clipboard the same on this computer and its paired devices.", [
  { key: "send_automatically", label: "Send copied text", hint: "Send what you copy here to every paired device.", type: "switch", default: true },
  { key: "receive_automatically", label: "Take copied text", hint: "Put what a paired device copies on this computer's clipboard.", type: "switch", default: true },
]);

export const notification_manifest = bundled("notification", "Notifications", "See a phone's notifications here, dismiss them and reply to messages.");

export const findmyphone_manifest = bundled("findmyphone", "Find my device", "Ring a device to find it, and let devices ring this one.");

export const share_manifest = bundled("share", "Share", "Send files, links and text to a device, and take them from it.", [
  { key: "open_links", label: "Open shared links", hint: "Open a link a device shares in the browser.", type: "switch", default: true },
  { key: "copy_text", label: "Copy shared text", hint: "Put text a device shares on this computer's clipboard.", type: "switch", default: true },
]);

export const runcommand_manifest = bundled("runcommand", "Run commands", "Let paired devices run the commands listed under Commands, and run theirs.");

export const connectivity_manifest = bundled("connectivity_report", "Mobile network", "See a phone's mobile network and signal strength.");

export const telephony_manifest = bundled("telephony", "Calls", "Hear about a phone's calls here, and mute its ringing.");

export const lock_manifest = bundled("lock", "Lock", "Lock and unlock this computer from a device, and lock a device from here.");

export const mpris_manifest = bundled("mpris", "Media players", "Control this computer's media players from a device, and a device's from here.");

export const systemvolume_manifest = bundled("systemvolume", "System volume", "Control this computer's speakers from a device, and a device's from here.");

export const contacts_manifest = bundled("contacts", "Contacts", "Read a phone's contacts, so messages and calls show names.");

export const sms_manifest = bundled("sms", "Messages", "Read and send a phone's text messages from here.");

export const sftp_manifest = bundled("sftp", "Browse files", "Open a phone's files in this computer's file manager, over SFTP.");

export const mousepad_manifest = bundled("mousepad", "Remote input", "Use a device as this computer's touchpad and keyboard, and type on a device from here.", [
  { key: "pointer_speed", label: "Pointer speed", hint: "How far the pointer moves for a stroke on the device's touchpad.", type: "number", default: 1 },
]);

export const presenter_manifest = bundled("presenter", "Presenter", "Use a phone as a remote and pointer for slides.", [
  { key: "pointer_speed", label: "Pointer speed", hint: "How far the pointer moves as the phone turns.", type: "number", default: 1000 },
]);

// ── This computer ────────────────────────────────────────────────────────────

// Readings and controls of the computer the daemon runs on, shown under This computer and published to Home Assistant.

export const processor_manifest = bundled("processor", "Processor and memory", "Read this computer's processor, graphics and memory load, and when it started.");

export const disks_manifest = bundled("disks", "Disks", "Read how full each disk is, and how fast they read and write.");

export const network_manifest = bundled("network", "Network", "Read each network card's traffic, this computer's address and its Wi-Fi signal.", [
  { key: "virtual_interfaces", label: "Virtual network cards", hint: "Also read containers' and virtual machines' network cards, such as docker0 or virbr0.", type: "switch", default: false },
]);

export const temperatures_manifest = bundled("temperatures", "Temperatures", "Read the temperature sensors of the processor, disks and other parts.");

export const power_manifest = bundled("power", "Power", "Shut down, restart or suspend this computer, keep it awake, and set its power profile and screen brightness.");

export const session_manifest = bundled("session", "Session", "See whether the session is locked or idle and whether the camera, microphone or speakers are in use; lock and unlock it.");

export const desktop_controls_manifest = bundled("desktop_controls", "Desktop controls", "Send this computer notifications, open links, type text, and control its media and speakers.", [
  { key: "publish_clipboard", label: "Show the clipboard", hint: "Read what is copied on this computer, for Home Assistant and This computer to show. Setting the clipboard works either way.", type: "switch", default: false },
]);

export const command_buttons_manifest = bundled("command_buttons", "Command buttons", "A button for each of your run commands, under This computer and in Home Assistant.");

export const system_services_manifest = bundled("system_services", "Services", "Start and stop the systemd services you name, and see whether they run.", [
  { key: "system_units", label: "System services", hint: "Unit names separated by commas, such as nginx.service. Starting and stopping them needs the right to.", type: "text", default: "" },
  { key: "user_units", label: "Your services", hint: "Your own units separated by commas, such as syncthing.service.", type: "text", default: "" },
]);

export const bundled_manifests: PluginManifest[] = [
  ping_manifest,
  battery_manifest,
  clipboard_manifest,
  notification_manifest,
  findmyphone_manifest,
  share_manifest,
  runcommand_manifest,
  connectivity_manifest,
  telephony_manifest,
  lock_manifest,
  mpris_manifest,
  systemvolume_manifest,
  contacts_manifest,
  sms_manifest,
  sftp_manifest,
  mousepad_manifest,
  presenter_manifest,
  processor_manifest,
  disks_manifest,
  network_manifest,
  temperatures_manifest,
  power_manifest,
  session_manifest,
  desktop_controls_manifest,
  command_buttons_manifest,
  system_services_manifest,
];
