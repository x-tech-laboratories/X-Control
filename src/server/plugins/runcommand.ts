// Run commands: the commands listed under Commands offered to every paired device, which can run them here, and a
// device's own commands, run from the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { runcommand_manifest } from "../../shared/plugins/manifests.ts";
import type { RemoteCommandState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi, DeviceHandle, RunCommand } from "./api.ts";
import { connected_devices, text_arg, text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const list_type = "kdeconnect.runcommand";
const request_type = "kdeconnect.runcommand.request";

// The list as KDE Connect sends it: a JSON text of the commands by key.
export function command_list(commands: RunCommand[]): string {
  return JSON.stringify(Object.fromEntries(commands.map((command) => [command.id, { name: command.name, command: command.command }])));
}

export function read_command_list(text: string): RemoteCommandState["commands"] {
  try {
    const parsed = JSON.parse(text) as Record<string, { name?: unknown; command?: unknown }>;
    return Object.entries(parsed).map(([key, entry]) => ({ key, name: String(entry?.name ?? key), command: String(entry?.command ?? "") }));
  } catch {
    return [];
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const runcommand_plugin = define_plugin<ControlPluginApi>({
  ...runcommand_manifest,
  start(context) {
    const devices = connected_devices();
    const { services } = context;

    const send_list = (device: DeviceHandle): Promise<void> | undefined =>
      device.takes(list_type) ? device.send(list_type, { commandList: command_list(services.commands()), canAddCommand: false }) : undefined;

    // A changed catalogue reaches every device at once.
    context.hook("commands.changed", async () => {
      await Promise.all(devices.all().map((device) => send_list(device)?.catch(() => undefined)));
    });

    context.provide("capability", "runcommand", {
      incoming: [request_type, list_type],
      outgoing: [list_type, request_type],
      async connected(device) {
        devices.add(device);
        await send_list(device);
        if (device.takes(request_type)) await device.send(request_type, { requestCommandList: true });
      },
      disconnected: devices.remove,
      async packet(device, packet) {
        if (packet.type === list_type) return device.set_state({ commands: read_command_list(text_field(packet.body, "commandList")) } satisfies RemoteCommandState);
        if (packet.body.requestCommandList === true) await send_list(device);
        const key = text_field(packet.body, "key");
        if (!key) return;
        const command = services.commands().find((candidate) => candidate.id === key);
        if (!command) return services.log(`${device.name} asked for a command that is not listed: ${key}`);
        services.log(`${device.name} runs ${command.name}`);
        const result = await services.system.run_shell(command.command);
        if (result.exit_code !== 0) services.log(`${command.name} failed with exit code ${result.exit_code}: ${result.output}`);
      },
      actions: {
        run: {
          label: "Run a command",
          description: "Runs one of the device's own commands, by its key from the device's command list.",
          params: [{ name: "key", schema: { type: "string", description: "The command's key." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { key: text_arg(args, "key") }),
        },
        refresh: { label: "Refresh commands", description: "Asks the device for its command list again.", needs: request_type, run: (device) => device.send(request_type, { requestCommandList: true }) },
      },
    });
  },
});
