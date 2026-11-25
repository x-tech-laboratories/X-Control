// Every plugin X-Control ships, in the order Settings lists them.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ControlPlugin } from "./api.ts";
import { battery_plugin } from "./battery.ts";
import { clipboard_plugin } from "./clipboard.ts";
import { connectivity_plugin } from "./connectivity.ts";
import { findmyphone_plugin } from "./findmyphone.ts";
import { lock_plugin } from "./lock.ts";
import { mpris_plugin } from "./mpris.ts";
import { notification_plugin } from "./notification.ts";
import { ping_plugin } from "./ping.ts";
import { runcommand_plugin } from "./runcommand.ts";
import { share_plugin } from "./share.ts";
import { systemvolume_plugin } from "./systemvolume.ts";
import { telephony_plugin } from "./telephony.ts";

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
];
