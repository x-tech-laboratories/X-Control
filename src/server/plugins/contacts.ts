// Contacts: a phone's address book, fetched when it connects and kept while the daemon runs, so messages and calls
// can show names rather than numbers.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { contacts_manifest } from "../../shared/plugins/manifests.ts";
import type { Contact, ContactsState } from "../../shared/plugins/states.ts";
export { name_for, number_key } from "../../shared/plugins/contacts.ts";
import type { ControlPluginApi } from "./api.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const ask_uids_type = "kdeconnect.contacts.request_all_uids_timestamps";
const ask_cards_type = "kdeconnect.contacts.request_vcards_by_uid";
const uids_type = "kdeconnect.contacts.response_uids_timestamps";
const cards_type = "kdeconnect.contacts.response_vcards";

// A vCard's name and phone numbers; lines folded onto the next one are joined first.
export function read_vcard(uid: string, text: string): Contact {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const value_of = (line: string): string => line.slice(line.indexOf(":") + 1).replace(/\\([,;\\])/g, "$1").trim();
  const name = lines.find((line) => /^FN[;:]/i.test(line));
  const phones = lines.filter((line) => /^(item\d+\.)?TEL[;:]/i.test(line)).map(value_of).filter(Boolean);
  return { uid, name: name ? value_of(name) : (phones[0] ?? "Unnamed contact"), phones };
}

// The uids a packet lists, as KDE Connect sends them beside the per-uid fields.
function uids_of(body: Record<string, unknown>): string[] {
  return Array.isArray(body.uids) ? body.uids.filter((uid): uid is string => typeof uid === "string") : [];
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const contacts_plugin = define_plugin<ControlPluginApi>({
  ...contacts_manifest,
  start(context) {
    context.provide("capability", "contacts", {
      keep_state: true,
      incoming: [uids_type, cards_type],
      outgoing: [ask_uids_type, ask_cards_type],
      connected: (device) => (device.takes(ask_uids_type) ? device.send(ask_uids_type, {}) : undefined),
      async packet(device, packet) {
        const known = device.state<ContactsState>()?.contacts ?? [];
        if (packet.type === uids_type) {
          const listed = new Set(uids_of(packet.body));
          // Contacts gone from the phone go here too; the rest are fetched again, since a timestamp alone cannot be trusted across phones.
          device.set_state({ contacts: known.filter((contact) => listed.has(contact.uid)) } satisfies ContactsState);
          if (listed.size > 0) await device.send(ask_cards_type, { uids: [...listed] });
          return;
        }
        const fresh = uids_of(packet.body).flatMap((uid) => (typeof packet.body[uid] === "string" ? [read_vcard(uid, packet.body[uid] as string)] : []));
        const replaced = new Set(fresh.map((contact) => contact.uid));
        const contacts = [...known.filter((contact) => !replaced.has(contact.uid)), ...fresh].sort((first, second) => first.name.localeCompare(second.name));
        device.set_state({ contacts } satisfies ContactsState);
      },
      actions: {
        refresh: { label: "Refresh contacts", description: "Fetches the phone's contacts again.", needs: ask_uids_type, run: (device) => device.send(ask_uids_type, {}) },
      },
    });
  },
});
