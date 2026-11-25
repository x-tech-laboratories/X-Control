// System volume: this computer's speakers listed to a device, which can turn them up, mute them or pick one, and a
// device's own speakers controlled from the page where it offers them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { systemvolume_manifest } from "../../shared/plugins/manifests.ts";
import type { AudioSink } from "../system/services.ts";
import type { RemoteSink, VolumeState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi, DeviceHandle } from "./api.ts";
import { connected_devices, number_field, text_arg, text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const volume_type = "kdeconnect.systemvolume";
const request_type = "kdeconnect.systemvolume.request";
const watch_interval_in_milliseconds = 3000;

export function sink_list(sinks: AudioSink[]): Record<string, unknown>[] {
  return sinks.map((sink) => ({ name: sink.name, description: sink.description, volume: sink.volume, maxVolume: sink.max_volume, muted: sink.muted, enabled: sink.is_default }));
}

export function read_sink_list(body: Record<string, unknown>): RemoteSink[] {
  if (!Array.isArray(body.sinkList)) return [];
  return body.sinkList.map((raw) => {
    const sink = (raw ?? {}) as Record<string, unknown>;
    return { name: text_field(sink, "name"), description: text_field(sink, "description"), volume: number_field(sink, "volume"), max_volume: number_field(sink, "maxVolume", 100), muted: sink.muted === true, enabled: sink.enabled === true };
  });
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const systemvolume_plugin = define_plugin<ControlPluginApi>({
  ...systemvolume_manifest,
  start(context) {
    const devices = connected_devices();
    const { volume } = context.services.system;
    let last = "";

    const send_sinks = async (targets: DeviceHandle[], sinks?: AudioSink[]): Promise<void> => {
      const body = { sinkList: sink_list(sinks ?? (await volume.list_sinks())) };
      await Promise.all(targets.filter((device) => device.takes(volume_type)).map((device) => device.send(volume_type, body).catch(() => undefined)));
    };

    const timer = setInterval(async () => {
      const listening = devices.all().filter((device) => device.takes(volume_type));
      if (listening.length === 0) return;
      const sinks = await volume.list_sinks().catch(() => null);
      if (!sinks) return;
      const now = JSON.stringify(sinks);
      if (now === last) return;
      last = now;
      await send_sinks(listening, sinks);
    }, watch_interval_in_milliseconds);
    context.on_stop(() => clearInterval(timer));

    const answer = async (device: DeviceHandle, body: Record<string, unknown>): Promise<void> => {
      const name = text_field(body, "name");
      if (name && typeof body.volume === "number") await volume.set_volume(name, body.volume);
      if (name && typeof body.muted === "boolean") await volume.set_muted(name, body.muted);
      if (name && body.enabled === true) await volume.make_default(name);
      await send_sinks([device]);
    };

    const remember = (device: DeviceHandle, body: Record<string, unknown>): void => {
      if (Array.isArray(body.sinkList)) return device.set_state({ sinks: read_sink_list(body) } satisfies VolumeState);
      const name = text_field(body, "name");
      const sinks = (device.state<VolumeState>()?.sinks ?? []).map((sink) =>
        sink.name !== name
          ? sink
          : { ...sink, volume: typeof body.volume === "number" ? body.volume : sink.volume, muted: typeof body.muted === "boolean" ? body.muted : sink.muted, enabled: typeof body.enabled === "boolean" ? body.enabled : sink.enabled },
      );
      device.set_state({ sinks } satisfies VolumeState);
    };

    const sink_arg = { name: "sink", schema: { type: "string", description: "The speaker's name, from the device's speakers." } };

    context.provide("capability", "systemvolume", {
      incoming: [volume_type, request_type],
      outgoing: [volume_type, request_type],
      async connected(device) {
        devices.add(device);
        if (device.takes(request_type)) await device.send(request_type, { requestSinks: true });
      },
      disconnected: devices.remove,
      packet: (device, packet) => (packet.type === request_type ? answer(device, packet.body) : remember(device, packet.body)),
      actions: {
        volume: {
          label: "Set a speaker's volume",
          description: "Sets the volume of one of the device's speakers, from 0 to its max_volume.",
          params: [sink_arg, { name: "volume", schema: { type: "number", minimum: 0, description: "The new volume." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { name: text_arg(args, "sink"), volume: Math.round(Number(args.volume)) }),
        },
        mute: {
          label: "Mute a speaker",
          description: "Mutes or unmutes one of the device's speakers.",
          params: [sink_arg, { name: "muted", schema: { type: "boolean", description: "True mutes it." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { name: text_arg(args, "sink"), muted: args.muted === true }),
        },
      },
    });
  },
});
