// The readings and controls of this computer, gathered from every plugin that offers them: each read when it falls
// due, the latest value kept with when it was read and why a read failed, and controls worked by id.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { EntityKind, EntityView, ReadingValue } from "../../shared/computer/model.ts";
import type { Entity, EntitySource, Reading } from "../plugins/api.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface ReadingsOptions {
  // Every plugin's entities, by plugin id.
  sources: () => { plugin_id: string; value: EntitySource }[];
  // Seconds a reading stays fresh, unless the entity asks for longer.
  interval: () => number;
  // Seconds between listing the entities again.
  relist_seconds?: number;
  // A read slower than this fails, so one stuck program holds up nothing else.
  timeout_ms?: number;
  log?: (message: string) => void;
}

export interface Readings {
  // Reads what is due, then gives every entity.
  refresh(): Promise<EntityView[]>;
  // The entities as last read, without reading.
  current(): EntityView[];
  set(id: string, value: ReadingValue): Promise<EntityView>;
  // Lists the entities again at the next refresh, such as after a plugin was turned on or off.
  forget_list(): void;
  // Runs with the entities that changed value after each refresh; returns the function that stops listening.
  subscribe(listener: (changed: EntityView[]) => void): () => void;
}

interface Kept {
  plugin_id: string;
  entity: Entity;
  value: ReadingValue;
  attributes: Record<string, unknown> | null;
  error: string | null;
  read_at: number | null;
}

// ── Values ───────────────────────────────────────────────────────────────────

const writable_kinds = new Set<EntityKind>(["switch", "button", "number", "select", "text"]);
const readable_kinds = new Set<EntityKind>(["sensor", "binary_sensor", "switch", "number", "select", "text"]);

export function is_writable(entity: Pick<Entity, "kind" | "set">): boolean {
  return writable_kinds.has(entity.kind) && typeof entity.set === "function";
}

// A value as a control of this kind takes it, from the page's JSON or Home Assistant's text.
export function value_for(kind: EntityKind, value: unknown, entity: Pick<Entity, "options" | "min" | "max"> = {}): ReadingValue {
  if (kind === "button") return null;
  if (kind === "switch") {
    if (typeof value === "boolean") return value;
    const text = String(value).toLowerCase();
    if (["on", "true", "1"].includes(text)) return true;
    if (["off", "false", "0"].includes(text)) return false;
    throw new Error("A switch takes on or off.");
  }
  if (kind === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error("This control takes a number.");
    if ((entity.min !== undefined && number < entity.min) || (entity.max !== undefined && number > entity.max)) throw new Error(`This control takes a number from ${entity.min} to ${entity.max}.`);
    return number;
  }
  const text = value === null || value === undefined ? "" : String(value);
  if (kind === "select" && entity.options && !entity.options.includes(text)) throw new Error(`This control takes one of ${entity.options.join(", ")}.`);
  return text;
}

function split(reading: Reading): { value: ReadingValue; attributes: Record<string, unknown> | null } {
  return reading !== null && typeof reading === "object" ? { value: reading.value, attributes: reading.attributes } : { value: reading, attributes: null };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} seconds`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function view_of(kept: Kept): EntityView {
  const { entity } = kept;
  return {
    id: `${kept.plugin_id}.${entity.id}`,
    plugin_id: kept.plugin_id,
    name: entity.name,
    kind: entity.kind,
    icon: entity.icon ?? null,
    unit: entity.unit ?? null,
    device_class: entity.device_class ?? null,
    category: entity.category ?? null,
    options: entity.options ?? null,
    min: entity.min ?? null,
    max: entity.max ?? null,
    step: entity.step ?? null,
    value: kept.value,
    attributes: kept.attributes,
    error: kept.error,
    read_at: kept.read_at === null ? null : new Date(kept.read_at).toISOString(),
  };
}

// ── Readings ─────────────────────────────────────────────────────────────────

export function create_readings(options: ReadingsOptions): Readings {
  const relist_ms = (options.relist_seconds ?? 60) * 1000;
  const timeout_ms = options.timeout_ms ?? 10_000;
  const listeners = new Set<(changed: EntityView[]) => void>();
  let kept = new Map<string, Kept>();
  let listed_at = 0;
  let running: Promise<EntityView[]> | null = null;

  async function relist(): Promise<void> {
    const next = new Map<string, Kept>();
    for (const source of options.sources()) {
      let entities: Entity[];
      try {
        entities = await within(Promise.resolve(source.value.list()), timeout_ms);
      } catch (error) {
        options.log?.(`readings of ${source.plugin_id}: ${error instanceof Error ? error.message : String(error)}`);
        // A source that fails keeps what it listed before.
        for (const [id, entry] of kept) if (entry.plugin_id === source.plugin_id) next.set(id, entry);
        continue;
      }
      for (const entity of entities) {
        const id = `${source.plugin_id}.${entity.id}`;
        const before = kept.get(id);
        next.set(id, before ? { ...before, entity } : { plugin_id: source.plugin_id, entity, value: null, attributes: null, error: null, read_at: null });
      }
    }
    kept = next;
    listed_at = Date.now();
  }

  async function read(entry: Kept): Promise<boolean> {
    if (!entry.entity.read || !readable_kinds.has(entry.entity.kind)) return false;
    const before = JSON.stringify([entry.value, entry.attributes, entry.error]);
    try {
      const { value, attributes } = split(await within(Promise.resolve(entry.entity.read()), timeout_ms));
      Object.assign(entry, { value, attributes, error: null });
    } catch (error) {
      Object.assign(entry, { value: null, attributes: null, error: error instanceof Error ? error.message : String(error) });
    }
    entry.read_at = Date.now();
    return JSON.stringify([entry.value, entry.attributes, entry.error]) !== before;
  }

  async function pass(): Promise<EntityView[]> {
    if (Date.now() - listed_at >= relist_ms) await relist();
    const now = Date.now();
    const interval_ms = Math.max(1, options.interval()) * 1000;
    // A little early still counts, so a reading on a timer of the same length is never skipped.
    const due = [...kept.values()].filter((entry) => entry.read_at === null || now - entry.read_at >= Math.max(interval_ms, (entry.entity.every ?? 0) * 1000) - 500);
    const changed = (await Promise.all(due.map(async (entry) => ((await read(entry)) ? [entry] : [])))).flat();
    if (changed.length > 0) {
      const views = changed.map(view_of);
      for (const listener of listeners) listener(views);
    }
    return [...kept.values()].map(view_of);
  }

  return {
    // Overlapping refreshes share one pass.
    refresh() {
      running ??= pass().finally(() => (running = null));
      return running;
    },
    current: () => [...kept.values()].map(view_of),
    async set(id, value) {
      if (!kept.has(id)) await relist();
      const entry = kept.get(id);
      if (!entry) throw new Error(`No reading or control called ${id}; list_readings gives the ids.`);
      if (!is_writable(entry.entity)) throw new Error(`${entry.entity.name} is a reading; it cannot be set.`);
      await within(Promise.resolve(entry.entity.set!(value_for(entry.entity.kind, value, entry.entity))), timeout_ms);
      if (await read(entry)) for (const listener of listeners) listener([view_of(entry)]);
      return view_of(entry);
    },
    forget_list: () => void (listed_at = 0),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
