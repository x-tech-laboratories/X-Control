// Share: files, links and text sent to a device, and taken from it: a file lands in the downloads folder, a link
// opens in the browser and text goes on the clipboard, each told to the user.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { share_manifest } from "../../shared/plugins/manifests.ts";
import type { Shared, ShareState } from "../../shared/plugins/states.ts";
import type { ControlPluginApi } from "./api.ts";
import { text_arg, text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const request_type = "kdeconnect.share.request";
const update_type = "kdeconnect.share.request.update";
const most_kept = 20;

// A file name that cannot leave the folder, such as "photo.jpg".
export function safe_file_name(name: string): string {
  const printable = [...name.replaceAll("\\", "/")].filter((character) => character.charCodeAt(0) >= 32).join("");
  return basename(printable).replace(/^\.+/, "") || "shared file";
}

// The path a new file takes in the folder, numbered when the name is taken: "photo (2).jpg".
export function free_path(folder: string, name: string): string {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let path = join(folder, name);
  for (let count = 2; existsSync(path); count++) path = join(folder, `${stem} (${count})${extension}`);
  return path;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const share_plugin = define_plugin<ControlPluginApi>({
  ...share_manifest,
  start(context) {
    const { system } = context.services;

    context.provide("capability", "share", {
      incoming: [request_type, update_type],
      outgoing: [request_type],
      async packet(device, packet, payload) {
        if (packet.type === update_type) return;
        const remember = (shared: Shared): void => {
          const received = device.state<ShareState>()?.received ?? [];
          device.set_state({ received: [shared, ...received].slice(0, most_kept) } satisfies ShareState);
        };
        const notify = (title: string, body: string): void => context.services.notify({ kind: "file_received", key: `share:${device.id}:${Date.now()}`, title, body, route: `#/devices/${device.id}` });
        const url = text_field(packet.body, "url");
        const text = text_field(packet.body, "text");
        if (payload) {
          const folder = context.services.downloads_folder();
          mkdirSync(folder, { recursive: true });
          const path = free_path(folder, safe_file_name(text_field(packet.body, "filename")));
          await pipeline(await payload.open(), createWriteStream(path));
          remember({ kind: "file", value: path, at: Date.now() });
          notify(`${device.name} sent a file`, basename(path));
          if (packet.body.open === true) await system.open(path).catch(() => undefined);
        } else if (url) {
          remember({ kind: "url", value: url, at: Date.now() });
          notify(`${device.name} shared a link`, url);
          if (context.settings().open_links !== false) await system.open(url).catch(() => undefined);
        } else if (text) {
          remember({ kind: "text", value: text, at: Date.now() });
          notify(`${device.name} shared text`, text.slice(0, 200));
          if (context.settings().copy_text !== false) await system.clipboard.write(text).catch(() => undefined);
        }
      },
      actions: {
        url: {
          label: "Share a link",
          description: "Opens a link on the device.",
          params: [{ name: "url", schema: { type: "string", description: "The link, such as https://example.org/." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { url: text_arg(args, "url") }),
        },
        text: {
          label: "Share text",
          description: "Sends text to the device, which offers to copy it.",
          params: [{ name: "text", schema: { type: "string", description: "The text to send." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { text: text_arg(args, "text") }),
        },
        file: {
          label: "Send a file",
          description: "Sends a file from the computer the daemon runs on to the device.",
          params: [
            { name: "path", schema: { type: "string", description: "The file's full path on the daemon's computer." } },
            { name: "open", schema: { type: "boolean", description: "Whether the device opens the file once it arrives." }, optional: true },
          ],
          needs: request_type,
          run: (device, args) => {
            const path = text_arg(args, "path");
            const stats = statSync(path);
            if (!stats.isFile()) throw new Error(`${path} is not a file.`);
            return device.send(
              request_type,
              { filename: basename(path), lastModified: Math.round(stats.mtimeMs), numberOfFiles: 1, totalPayloadSize: stats.size, open: args.open === true },
              { size: stats.size, open: () => createReadStream(path) },
            );
          },
        },
      },
    });
  },
});
