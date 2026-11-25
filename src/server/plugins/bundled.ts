// Every plugin X-Control ships, in the order Settings lists them.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ControlPlugin } from "./api.ts";
import { battery_plugin } from "./battery.ts";
import { clipboard_plugin } from "./clipboard.ts";
import { command_buttons_plugin } from "./command_buttons.ts";
import { connectivity_plugin } from "./connectivity.ts";
import { contacts_plugin } from "./contacts.ts";
import { desktop_controls_plugin } from "./desktop_controls.ts";
import { disks_plugin } from "./disks.ts";
import { findmyphone_plugin } from "./findmyphone.ts";
import { lock_plugin } from "./lock.ts";
import { mousepad_plugin } from "./mousepad.ts";
import { mpris_plugin } from "./mpris.ts";
import { network_plugin } from "./network.ts";
import { notification_plugin } from "./notification.ts";
import { ping_plugin } from "./ping.ts";
import { power_plugin } from "./power.ts";
import { presenter_plugin } from "./presenter.ts";
import { processor_plugin } from "./processor.ts";
import { runcommand_plugin } from "./runcommand.ts";
import { session_plugin } from "./session.ts";
import { sftp_plugin } from "./sftp.ts";
import { share_plugin } from "./share.ts";
import { sms_plugin } from "./sms.ts";
import { system_services_plugin } from "./system_services.ts";
import { systemvolume_plugin } from "./systemvolume.ts";
import { telephony_plugin } from "./telephony.ts";
import { temperatures_plugin } from "./temperatures.ts";

// ── Plugins ──────────────────────────────────────────────────────────────────

export const bundled_plugins: ControlPlugin[] = [
  ping_plugin,
  battery_plugin,
  clipboard_plugin,
  notification_plugin,
  findmyphone_plugin,
  share_plugin,
  runcommand_plugin,
  connectivity_plugin,
  telephony_plugin,
  lock_plugin,
  mpris_plugin,
  systemvolume_plugin,
  contacts_plugin,
  sms_plugin,
  sftp_plugin,
  mousepad_plugin,
  presenter_plugin,
  processor_plugin,
  disks_plugin,
  network_plugin,
  temperatures_plugin,
  power_plugin,
  session_plugin,
  desktop_controls_plugin,
  command_buttons_plugin,
  system_services_plugin,
];
