// Remote input: a device used as this computer's touchpad and keyboard, and text and keys typed on a device from
// here when its keyboard is ready.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { mousepad_manifest } from "../../shared/plugins/manifests.ts";
import type { InputState } from "../../shared/plugins/states.ts";
import { special_keys, type Modifier, type SpecialKey } from "../system/services.ts";
import type { ControlPluginApi } from "./api.ts";
import { number_field, text_arg, text_field } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const request_type = "kdeconnect.mousepad.request";
const echo_type = "kdeconnect.mousepad.echo";
const keyboard_type = "kdeconnect.mousepad.keyboardstate";

// KDE Connect's numbered special keys: 1 is BackSpace, 12 Return and 21 to 32 are F1 to F12.
const numbered_keys: (SpecialKey | null)[] = [null, "BackSpace", "Tab", "Return", "Left", "Up", "Right", "Down", "Prior", "Next", "Home", "End", "Return", "Delete", "Escape", "Sys_Req", "Scroll_Lock", null, null, null, null, "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];

export function special_key_of(number: number): SpecialKey | null {
  return numbered_keys[number] ?? null;
}

export function number_of_special_key(key: string): number {
  return numbered_keys.indexOf(key as SpecialKey);
}

export function modifiers_of(body: Record<string, unknown>): Modifier[] {
  return (["ctrl", "alt", "shift", "super"] as const).filter((modifier) => body[modifier] === true);
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const mousepad_plugin = define_plugin<ControlPluginApi>({
  ...mousepad_manifest,
  start(context) {
    const { input } = context.services.system;
    const speed = (): number => Number(context.settings().pointer_speed) || 1;

    context.provide("capability", "mousepad", {
      incoming: [request_type, echo_type, keyboard_type],
      outgoing: [request_type, echo_type, keyboard_type],
      // This computer takes keys, so the device offers its keyboard.
      connected: (device) => (device.takes(keyboard_type) ? device.send(keyboard_type, { state: true }) : undefined),
      async packet(device, packet) {
        const body = packet.body;
        if (packet.type === keyboard_type) return device.set_state({ keyboard_ready: body.state === true } satisfies InputState);
        if (packet.type === echo_type) return;
        const modifiers = modifiers_of(body);
        const special = special_key_of(number_field(body, "specialKey"));
        const key = text_field(body, "key");
        if (body.singleclick === true) await input.click("left", "click");
        if (body.doubleclick === true) await input.click("left", "double");
        if (body.middleclick === true) await input.click("middle", "click");
        if (body.rightclick === true) await input.click("right", "click");
        if (body.singlehold === true) await input.click("left", "press");
        if (body.singlerelease === true) await input.click("left", "release");
        const dx = number_field(body, "dx");
        const dy = number_field(body, "dy");
        if (body.scroll === true) await input.scroll(dx, dy);
        else if (dx || dy) await input.move(dx * speed(), dy * speed());
        if (special) await input.key(special, modifiers);
        else if (key && modifiers.length > 0) await input.key(key, modifiers);
        else if (key) await input.type(key);
        // A device that asks is told the key arrived, so it can show it.
        if (body.sendAck === true && (key || special)) await device.send(echo_type, { ...(key ? { key } : { specialKey: number_field(body, "specialKey") }), ...Object.fromEntries(modifiers.map((modifier) => [modifier, true])), isAck: true });
      },
      actions: {
        type: {
          label: "Type text",
          description: "Types text on the device, into whatever field has the focus there.",
          params: [{ name: "text", schema: { type: "string", description: "The text to type." } }],
          needs: request_type,
          run: (device, args) => device.send(request_type, { key: text_arg(args, "text") }),
        },
        key: {
          label: "Press a key",
          description: `Presses one key on the device, one of ${special_keys.join(", ")}, with modifiers held if given.`,
          params: [
            { name: "key", schema: { type: "string", enum: [...special_keys] } },
            { name: "modifiers", schema: { type: "array", items: { type: "string", enum: ["ctrl", "alt", "shift", "super"] } }, optional: true },
          ],
          needs: request_type,
          run: (device, args) => {
            const number = number_of_special_key(text_arg(args, "key"));
            if (number < 1) throw new Error(`The key is one of ${special_keys.join(", ")}.`);
            const held = Array.isArray(args.modifiers) ? args.modifiers.filter((modifier): modifier is string => typeof modifier === "string") : [];
            return device.send(request_type, { specialKey: number, ...Object.fromEntries(held.map((modifier) => [modifier, true])) });
          },
        },
      },
    });
  },
});
