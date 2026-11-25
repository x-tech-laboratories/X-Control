// What several plugins share: the paired devices connected now, and reading a packet body's fields safely.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeviceHandle } from "./api.ts";

// ── Connected devices ────────────────────────────────────────────────────────

// The devices a capability has seen connect and not yet go, by id.
export function connected_devices() {
  const devices = new Map<string, DeviceHandle>();
  return {
    add: (device: DeviceHandle): void => void devices.set(device.id, device),
    remove: (device: DeviceHandle): void => void devices.delete(device.id),
    all: (): DeviceHandle[] => [...devices.values()].filter((device) => device.is_connected() && device.is_paired()),
  };
}

// ── Fields ───────────────────────────────────────────────────────────────────

export function text_field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

export function number_field(body: Record<string, unknown>, key: string, fallback = 0): number {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function text_arg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") throw new Error(`${key} is needed.`);
  return value;
}

// ── Readings ─────────────────────────────────────────────────────────────────

// Rates per second of counters that only grow, such as bytes received, worked out between readings of each key;
// null on the first reading and after a counter starts again.
export function rate_tracker() {
  const last = new Map<string, { value: number; at: number }>();
  return (key: string, value: number, now = Date.now()): number | null => {
    const before = last.get(key);
    last.set(key, { value, at: now });
    if (!before || now <= before.at || value < before.value) return null;
    return (value - before.value) / ((now - before.at) / 1000);
  };
}

// A share as a percentage with one decimal.
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

// Bytes in GiB with two decimals.
export function in_gib(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

// A list of names a user typed, split at commas and spaces.
export function names_in(text: unknown): string[] {
  return typeof text === "string" ? [...new Set(text.split(/[\s,]+/).filter(Boolean))] : [];
}

// A reading shared by the entities read in one pass, so a program runs once rather than once for each; forget() makes
// the next call read again, as after a control changed what it reads.
export function shared_reading<T>(read: () => Promise<T>, ms = 2000): (() => Promise<T>) & { forget(): void } {
  let kept: { at: number; promise: Promise<T> } | null = null;
  const get = (): Promise<T> => {
    if (!kept || Date.now() - kept.at >= ms) kept = { at: Date.now(), promise: read() };
    return kept.promise;
  };
  return Object.assign(get, { forget: () => void (kept = null) });
}
