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
