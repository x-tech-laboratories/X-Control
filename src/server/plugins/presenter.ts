// Presenter: a phone used as a slide remote moves this computer's pointer as it turns; its next and previous
// buttons arrive as keys through the remote input plugin.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { presenter_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi } from "./api.ts";
import { number_field } from "./helpers.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

const presenter_type = "kdeconnect.presenter";

export const presenter_plugin = define_plugin<ControlPluginApi>({
  ...presenter_manifest,
  start(context) {
    context.provide("capability", "presenter", {
      incoming: [presenter_type],
      outgoing: [],
      async packet(_device, packet) {
        if (packet.body.stop === true) return;
        // The phone sends how far it turned as small fractions, scaled here to pixels.
        const speed = Number(context.settings().pointer_speed) || 1000;
        const dx = number_field(packet.body, "dx") * speed;
        const dy = number_field(packet.body, "dy") * speed;
        if (dx || dy) await context.services.system.input.move(dx, dy);
      },
    });
  },
});
