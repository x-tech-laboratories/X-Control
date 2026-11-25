// Mobile network: a phone's network type and signal strength for each of its SIM cards.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { connectivity_manifest } from "../../shared/plugins/manifests.ts";
import type { SignalState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi } from "./api.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const report_type = "kdeconnect.connectivity_report";
const request_type = "kdeconnect.connectivity_report.request";

// The report's signals, leaving out anything malformed.
export function read_signals(body: Record<string, unknown>): SignalState["signals"] {
  const raw = body.signalStrengths;
  if (!raw || typeof raw !== "object") return {};
  const signals: SignalState["signals"] = {};
  for (const [sim, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as { networkType?: unknown; signalStrength?: unknown };
    if (typeof entry?.signalStrength !== "number") continue;
    signals[sim] = { network: typeof entry.networkType === "string" ? entry.networkType : "", strength: entry.signalStrength };
  }
  return signals;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const connectivity_plugin = define_plugin<ControlPluginApi>({
  ...connectivity_manifest,
  start(context) {
    context.provide("capability", "connectivity_report", {
      incoming: [report_type],
      outgoing: [request_type],
      connected: (device) => (device.takes(request_type) ? device.send(request_type, {}) : undefined),
      packet: (device, packet) => device.set_state({ signals: read_signals(packet.body) } satisfies SignalState),
    });
  },
});
