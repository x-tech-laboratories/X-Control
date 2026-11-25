// System Bridge's client keys and pairing codes: keys in its own format, so Home Assistant takes them as keys rather
// than codes, kept only as SHA-256 hashes in a file beside this device's identity, and short-lived codes a client
// trades for a key of its own.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

// ── Key format ───────────────────────────────────────────────────────────────

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const key_pattern = /^([a-z][0-9a-z-]*)_([a-z][0-9a-z-]*)_([0-9A-Za-z]{43})([0-9A-Za-z]{6})$/;

function to_base62(value: number, width: number): string {
  let text = "";
  let left = value;
  while (left > 0) {
    text = base62[left % 62] + text;
    left = Math.floor(left / 62);
  }
  return text.padStart(width, "0");
}

// Random base62 characters, drawn without bias.
function random_base62(count: number): string {
  let text = "";
  while (text.length < count) {
    for (const byte of randomBytes(count * 2)) {
      if (byte < 248 && text.length < count) text += base62[byte % 62];
    }
  }
  return text;
}

// A new key such as "system-bridge_client_<43 characters><6-character checksum>".
export function make_key(kind = "client"): string {
  const body = `system-bridge_${kind}_${random_base62(43)}`;
  return body + to_base62(crc32(Buffer.from(body, "utf8")), 6);
}

// Whether text has the key format and its checksum holds.
export function is_key(text: string): boolean {
  const match = key_pattern.exec(text);
  if (!match || match[1] !== "system-bridge") return false;
  const body = text.slice(0, -6);
  return to_base62(crc32(Buffer.from(body, "utf8")), 6) === match[4];
}

function hash_of(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface KeyRecord {
  id: string;
  // Who the key was made for, such as "Home Assistant".
  name: string;
  kind: string;
  hash: string;
  created_at: string;
}

export interface KeyView {
  id: string;
  name: string;
  kind: string;
  created_at: string;
}

export interface KeyStore {
  list(): KeyView[];
  // Makes a key and gives it back; only its hash is kept, so it is never shown again.
  create(name: string, kind?: string): { key: string; view: KeyView };
  remove(id: string): void;
  // The key's record, or null when no key matches.
  check(key: string): KeyView | null;
  // A code a client trades for a key within the minutes given.
  pairing_code(minutes?: number): { code: string; expires_at: string };
  // Trades a pairing code for a new key, once.
  pair(code: string, name: string, kind: string): string | null;
}

const code_letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function create_key_store(file: string, now: () => number = Date.now): KeyStore {
  const read = (): KeyRecord[] => {
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { keys?: KeyRecord[] };
      return Array.isArray(parsed.keys) ? parsed.keys : [];
    } catch {
      return [];
    }
  };
  const write = (keys: KeyRecord[]): void => writeFileSync(file, JSON.stringify({ keys }, null, 2), { mode: 0o600 });
  const view = ({ id, name, kind, created_at }: KeyRecord): KeyView => ({ id, name, kind, created_at });
  const codes = new Map<string, number>();

  const store: KeyStore = {
    list: () => read().map(view),
    create(name, kind = "client") {
      const key = make_key(kind);
      const record: KeyRecord = { id: randomUUID(), name: name.trim().slice(0, 64) || "Client", kind, hash: hash_of(key), created_at: new Date(now()).toISOString() };
      write([...read(), record]);
      return { key, view: view(record) };
    },
    remove: (id) => write(read().filter((record) => record.id !== id)),
    check(key) {
      if (!is_key(key)) return null;
      const wanted = Buffer.from(hash_of(key), "hex");
      const found = read().find((record) => timingSafeEqual(Buffer.from(record.hash, "hex"), wanted));
      return found ? view(found) : null;
    },
    pairing_code(minutes = 10) {
      for (const [code, expires] of codes) if (expires <= now()) codes.delete(code);
      const code = [...randomBytes(8)].map((byte) => code_letters[byte % code_letters.length]).join("");
      const expires = now() + minutes * 60_000;
      codes.set(code, expires);
      return { code, expires_at: new Date(expires).toISOString() };
    },
    pair(code, name, kind) {
      const wanted = code.trim().toUpperCase();
      const expires = codes.get(wanted);
      if (expires === undefined) return null;
      codes.delete(wanted);
      return expires > now() ? store.create(name, kind).key : null;
    },
  };
  return store;
}
