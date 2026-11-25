// Phone numbers matched to a phone's contacts, for the messages and calls the page shows.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Contact } from "./states.ts";

// ── Names ────────────────────────────────────────────────────────────────────

// A phone number stripped to its digits and the last nine of them, so "+44 7946 000000" matches "07946000000".
export function number_key(number: string): string {
  return number.replace(/\D/g, "").slice(-9);
}

// The contact's name for a number, or the number itself.
export function name_for(contacts: Contact[], number: string): string {
  const key = number_key(number);
  if (!key) return number;
  return contacts.find((contact) => contact.phones.some((phone) => number_key(phone) === key))?.name ?? number;
}
