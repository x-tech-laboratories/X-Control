// Notifications: a phone's notifications shown on this computer as well, kept in a list the page shows, and
// dismissed, answered or acted on from there; and this computer's own notifications sent to paired devices, as
// Valent's fdo plugin does.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { notification_manifest } from "../../shared/plugins/manifests.ts";
import type { PhoneNotification, NotificationState } from "../../shared/plugins/states.ts";
import type { DesktopNotice } from "../system/services.ts";
import type { ControlPluginApi } from "./api.ts";
import { connected_devices, names_in, number_field, text_arg, text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const notification_type = "kdeconnect.notification";
const request_type = "kdeconnect.notification.request";
const action_type = "kdeconnect.notification.action";
const reply_type = "kdeconnect.notification.reply";

// The notification a packet describes.
export function read_notification(body: Record<string, unknown>): PhoneNotification {
  return {
    id: text_field(body, "id"),
    app: text_field(body, "appName"),
    title: text_field(body, "title") || text_field(body, "ticker"),
    text: text_field(body, "text"),
    time: Number(body.time) || number_field(body, "time", Date.now()),
    is_clearable: body.isClearable !== false,
    actions: Array.isArray(body.actions) ? body.actions.filter((action): action is string => typeof action === "string") : [],
    reply_id: text_field(body, "requestReplyId") || null,
  };
}

// Whether a desktop notification goes to devices: never X-Control's own, which would echo a phone's back to it, nor
// one from an app the user listed, nor one with nothing to say.
export function should_forward(notice: DesktopNotice, skipped: string[]): boolean {
  const app = notice.app.toLowerCase();
  if (app === "x-control" || (!notice.title && !notice.body)) return false;
  return !skipped.some((name) => name.toLowerCase() === app);
}

// The packet a desktop notification goes to a device as.
export function desktop_notification_body(notice: DesktopNotice, id: string, now = Date.now()): Record<string, unknown> {
  const title = notice.title || notice.app;
  return { id, appName: notice.app || "X-Control", title, text: notice.body, ticker: notice.body ? `${title}: ${notice.body}` : title, isClearable: true, time: String(now), silent: notice.urgency === "low" };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const notification_plugin = define_plugin<ControlPluginApi>({
  ...notification_manifest,
  start(context) {
    const list_of = (state: NotificationState | undefined): PhoneNotification[] => state?.notifications ?? [];
    const key_of = (device_id: string, id: string): string => `notification:${device_id}:${id}`;
    const devices = connected_devices();
    let sent = 0;

    // This computer's notifications go to every connected device that shows them.
    const stop_watching = context.services.system.notices.watch((notice) => {
      if (context.settings().forward_desktop === false || !should_forward(notice, names_in(context.settings().skip_apps))) return;
      const body = desktop_notification_body(notice, `x-control-${Date.now()}-${++sent}`);
      for (const device of devices.all()) if (device.takes(notification_type)) void device.send(notification_type, body).catch(() => undefined);
    });
    context.on_stop(stop_watching);

    context.provide("capability", "notification", {
      incoming: [notification_type, request_type],
      outgoing: [notification_type, request_type, action_type, reply_type],
      connected: (device) => {
        devices.add(device);
        return device.takes(request_type) ? device.send(request_type, { request: true }) : undefined;
      },
      disconnected: (device) => devices.remove(device),
      packet(device, packet) {
        // A device dismissing one of this computer's notifications, or asking for them; they were shown once and are not kept.
        if (packet.type === request_type) return;
        const id = text_field(packet.body, "id");
        if (!id) return;
        const others = list_of(device.state<NotificationState>()).filter((notification) => notification.id !== id);
        if (packet.body.isCancel === true) {
          device.set_state({ notifications: others } satisfies NotificationState);
          return context.services.withdraw(key_of(device.id, id));
        }
        const notification = read_notification(packet.body);
        device.set_state({ notifications: [notification, ...others] } satisfies NotificationState);
        // A notification the phone already showed before connecting, or asked to stay quiet, is listed but not shown.
        if (packet.body.silent === true || packet.body.onlyOnce === true) return;
        context.services.notify({
          kind: "phone_notification",
          key: key_of(device.id, id),
          title: [notification.app, notification.title].filter(Boolean).join(": ") || device.name,
          body: notification.text,
          route: `#/devices/${device.id}`,
        });
      },
      actions: {
        dismiss: {
          label: "Dismiss",
          description: "Dismisses one of the phone's notifications, on the phone too.",
          params: [{ name: "id", schema: { type: "string", description: "The notification's id, from the device's notifications." } }],
          needs: request_type,
          run: async (device, args) => {
            const id = text_arg(args, "id");
            await device.send(request_type, { cancel: id });
            device.set_state({ notifications: list_of(device.state<NotificationState>()).filter((notification) => notification.id !== id) } satisfies NotificationState);
            context.services.withdraw(key_of(device.id, id));
          },
        },
        reply: {
          label: "Reply",
          description: "Answers a notification that takes a reply, such as a chat message.",
          params: [
            { name: "reply_id", schema: { type: "string", description: "The notification's reply_id." } },
            { name: "message", schema: { type: "string", description: "The answer to send." } },
          ],
          needs: reply_type,
          run: (device, args) => device.send(reply_type, { requestReplyId: text_arg(args, "reply_id"), message: text_arg(args, "message") }),
        },
        act: {
          label: "Act",
          description: "Presses one of a notification's buttons, such as Mark as read.",
          params: [
            { name: "id", schema: { type: "string", description: "The notification's id." } },
            { name: "action", schema: { type: "string", description: "The button's label, one of the notification's actions." } },
          ],
          needs: action_type,
          run: (device, args) => device.send(action_type, { key: text_arg(args, "id"), action: text_arg(args, "action") }),
        },
      },
    });
  },
});
