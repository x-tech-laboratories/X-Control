// Command buttons: each run command under Commands as a button, so Home Assistant and This computer run it here, as
// LNXlink's bash module runs the commands in its config.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import { command_buttons_manifest } from "../../shared/plugins/manifests.ts";
import type { ControlPluginApi, Entity } from "./api.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const command_buttons_plugin = define_plugin<ControlPluginApi>({
  ...command_buttons_manifest,
  start(context) {
    const { services } = context;
    context.provide("entities", "commands", {
      list: (): Entity[] =>
        services.commands().map((command) => ({
          id: slug(command.id),
          name: command.name,
          kind: "button",
          icon: "mdi:console",
          set: async () => {
            // Read again, so a command changed since the list was made runs as it is now.
            const current = services.commands().find((entry) => entry.id === command.id);
            if (!current) throw new Error(`${command.name} was removed.`);
            const result = await services.system.run_shell(current.command);
            services.log(`ran ${current.name}: exit code ${result.exit_code}`);
            if (result.exit_code !== 0) throw new Error(`${current.name} failed with exit code ${result.exit_code}${result.output ? `: ${result.output.slice(0, 200)}` : ""}`);
          },
        })),
    });
  },
});
