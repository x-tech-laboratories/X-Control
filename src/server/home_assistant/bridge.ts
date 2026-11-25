// This computer in Home Assistant, over MQTT as LNXlink does it: every reading and control announced through MQTT
// discovery under one device, their values published as they change, and commands from Home Assistant worked
// through the same controls the page uses. A retained last will marks the computer offline when the daemon goes, it
// reconnects with backoff, announces everything again when Home Assistant restarts, and clears the configs of
// entities that went away, such as a plugin turned off.

// ── Imports ──────────────────────────────────────────────────────────────────

import { slug } from "@x-tech-laboratories/x-libs/server/mqtt_discovery";

import type { EntityView, HomeAssistantStatus, ReadingValue } from "../../shared/computer/model.ts";
import type { Readings } from "../computer/readings.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface HomeAssistantSettings {
  enabled: boolean;
  // Such as "mqtt://homeassistant.local:1883" or "mqtts://broker.example.org:8883".
  broker: string;
  username: string;
  password: string;
  discovery_prefix: string;
  base_topic: string;
  // Seconds between readings.
  interval: number;
}

export const default_home_assistant_settings: HomeAssistantSettings = { enabled: false, broker: "", username: "", password: "", discovery_prefix: "homeassistant", base_topic: "x-control", interval: 10 };

export const backoff_seconds = { min: 1, max: 60 };

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface Connection {
  url: string;
  client_id: string;
  username: string | null;
  password: string | null;
  will: { topic: string; payload: string };
}

// One connection to the broker, as the bridge uses it.
export interface MqttSession {
  publish(topic: string, payload: string, retain: boolean): Promise<void>;
  subscribe(topics: string[]): Promise<void>;
  on_message(listener: (topic: string, payload: string) => void): void;
  // Runs once when the connection drops.
  on_close(listener: (error: Error) => void): void;
  end(): Promise<void>;
}

export type SessionFactory = (connection: Connection) => Promise<MqttSession>;

// A session on the mqtt package, which leaves reconnecting to the bridge.
export const mqtt_session: SessionFactory = async (connection) => {
  const mqtt = await import("mqtt");
  const client = await mqtt.connectAsync(connection.url, {
    clientId: connection.client_id,
    ...(connection.username ? { username: connection.username } : {}),
    ...(connection.password ? { password: connection.password } : {}),
    connectTimeout: 10_000,
    reconnectPeriod: 0,
    will: { topic: connection.will.topic, payload: Buffer.from(connection.will.payload), qos: 1, retain: true },
  });
  let closed = false;
  const close_listeners: ((error: Error) => void)[] = [];
  const close = (error: Error): void => {
    if (closed) return;
    closed = true;
    for (const listener of close_listeners) listener(error);
  };
  client.on("close", () => close(new Error("the broker closed the connection")));
  client.on("error", (error) => close(error));
  return {
    publish: async (topic, payload, retain) => void (await client.publishAsync(topic, payload, { qos: 1, retain })),
    subscribe: async (topics) => void (await client.subscribeAsync(topics, { qos: 1 })),
    on_message: (listener) => void client.on("message", (topic, payload) => listener(topic, payload.toString("utf8"))),
    on_close: (listener) => void close_listeners.push(listener),
    end: async () => {
      closed = true;
      await client.endAsync();
    },
  };
};

// ── Topics ───────────────────────────────────────────────────────────────────

export interface Device {
  id: string;
  name: string;
  version: string;
}

export interface Topics {
  node: string;
  base: string;
  availability: string;
  discovery_prefix: string;
}

export function topics_for(settings: Pick<HomeAssistantSettings, "base_topic" | "discovery_prefix">, device: Pick<Device, "id">): Topics {
  const base = `${settings.base_topic.replace(/\/+$/, "") || "x-control"}/${slug(device.id)}`;
  return { node: `x_control_${slug(device.id)}`, base, availability: `${base}/status`, discovery_prefix: settings.discovery_prefix.replace(/\/+$/, "") || "homeassistant" };
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An entity's id as one topic level, such as "processor_usage" for "processor.usage".
export function level_of(id: string): string {
  return slug(id.replace(/\./g, "_"));
}

// A value as Home Assistant reads it: ON or OFF, a number, text, or None while unknown.
export function payload_of(entity: Pick<EntityView, "kind" | "value">): string {
  const { value } = entity;
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (value === null) return entity.kind === "text" ? "" : "None";
  return String(value);
}

// The discovery topic and config of one entity.
export function entity_config(entity: EntityView, topics: Topics, device: Device): [string, Record<string, unknown>] {
  const level = level_of(entity.id);
  const config: Record<string, unknown> = {
    name: entity.name,
    unique_id: `${topics.node}_${level}`,
    availability_topic: topics.availability,
    device: { identifiers: [topics.node], name: device.name, manufacturer: "X-Tech Laboratories", model: "X-Control", sw_version: device.version },
    origin: { name: "X-Control", sw_version: device.version, support_url: "https://github.com/x-tech-laboratories/X-Control" },
  };
  if (entity.kind !== "button") config.state_topic = `${topics.base}/${level}/state`;
  if (["switch", "button", "number", "select", "text"].includes(entity.kind)) config.command_topic = `${topics.base}/${level}/set`;
  if (entity.kind !== "button" && entity.kind !== "text") config.json_attributes_topic = `${topics.base}/${level}/attributes`;
  if (entity.icon) config.icon = entity.icon;
  if (entity.unit) config.unit_of_measurement = entity.unit;
  if (entity.device_class) config.device_class = entity.device_class;
  if (entity.category) config.entity_category = entity.category;
  if (entity.kind === "sensor" && (typeof entity.value === "number" || entity.unit)) config.state_class = "measurement";
  if (entity.kind === "select") config.options = entity.options ?? [];
  if (entity.kind === "number") Object.assign(config, { min: entity.min ?? 0, max: entity.max ?? 100, step: entity.step ?? 1 });
  if (entity.kind === "text") config.max = 255;
  return [`${topics.discovery_prefix}/${entity.kind}/${topics.node}/${level}/config`, config];
}

// ── Bridge ───────────────────────────────────────────────────────────────────

export interface BridgeOptions {
  readings: Readings;
  settings: () => HomeAssistantSettings;
  device: () => Device;
  connect?: SessionFactory;
  // The bridge's status changed.
  on_status?: (status: HomeAssistantStatus) => void;
  log?: (message: string) => void;
}

export interface HomeAssistantBridge {
  start(): void;
  // Connects again with the settings as they are now, or stops when they turn it off.
  restart(): void;
  status(): HomeAssistantStatus;
  stop(): Promise<void>;
}

export function create_home_assistant_bridge(options: BridgeOptions): HomeAssistantBridge {
  const connect = options.connect ?? mqtt_session;
  const log = options.log ?? (() => {});
  let generation = 0;
  let running: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let current: HomeAssistantStatus = { state: "off", broker: null, error: null, base_topic: null, entities: 0, connected_at: null };

  const set_status = (next: Partial<HomeAssistantStatus>): void => {
    current = { ...current, ...next };
    options.on_status?.(current);
  };

  // Waits the seconds given, or less when the bridge restarts or stops.
  const pause = (seconds: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, seconds * 1000);
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  // One connection, from connecting until it drops or the bridge restarts.
  async function serve(session: MqttSession, settings: HomeAssistantSettings, topics: Topics, mine: number): Promise<void> {
    const published_configs = new Map<string, string>();
    const published_states = new Map<string, string>();
    let levels = new Map<string, string>();
    const link: { dropped: Error | null } = { dropped: null };
    session.on_close((error) => {
      link.dropped = error;
      wake?.();
    });

    const publish = (topic: string, payload: string, retain: boolean): Promise<void> => session.publish(topic, payload, retain);

    async function publish_states(entities: EntityView[]): Promise<void> {
      for (const entity of entities) {
        if (entity.kind === "button") continue;
        const level = level_of(entity.id);
        const state = payload_of(entity);
        if (published_states.get(level) !== state) {
          published_states.set(level, state);
          await publish(`${topics.base}/${level}/state`, state, false);
        }
        const attributes = JSON.stringify({ ...entity.attributes, ...(entity.error ? { error: entity.error } : {}) });
        if (entity.kind !== "text" && published_states.get(`${level}/attributes`) !== attributes) {
          published_states.set(`${level}/attributes`, attributes);
          await publish(`${topics.base}/${level}/attributes`, attributes, false);
        }
      }
    }

    async function publish_configs(entities: EntityView[]): Promise<void> {
      const device = options.device();
      const wanted = new Map(entities.map((entity) => {
        const [topic, config] = entity_config(entity, topics, device);
        return [topic, JSON.stringify(config)];
      }));
      levels = new Map(entities.map((entity) => [level_of(entity.id), entity.id]));
      for (const [topic, config] of wanted) {
        if (published_configs.get(topic) === config) continue;
        published_configs.set(topic, config);
        await publish(topic, config, true);
      }
      for (const topic of [...published_configs.keys()].filter((topic) => !wanted.has(topic))) {
        published_configs.delete(topic);
        await publish(topic, "", true);
      }
      set_status({ entities: wanted.size });
    }

    // Home Assistant restarted, so it hears everything again.
    async function announce_all(): Promise<void> {
      published_configs.clear();
      published_states.clear();
      const entities = options.readings.current();
      await publish_configs(entities);
      await publish_states(entities);
    }

    const handle = async (topic: string, payload: string): Promise<void> => {
      if (topic === `${topics.discovery_prefix}/status`) {
        if (payload === "online") await announce_all();
        return;
      }
      // A retained config of this computer that no entity has now, left from an earlier run.
      const config = new RegExp(`^${escaped(topics.discovery_prefix)}/[^/]+/${escaped(topics.node)}/[^/]+/config$`);
      if (config.test(topic)) {
        if (payload !== "" && !published_configs.has(topic)) await publish(topic, "", true);
        return;
      }
      const command = new RegExp(`^${escaped(topics.base)}/([^/]+)/set$`).exec(topic);
      const id = command ? levels.get(command[1]!) : undefined;
      if (!id) return;
      try {
        await publish_states([await options.readings.set(id, payload as ReadingValue)]);
      } catch (error) {
        log(`Home Assistant set ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    session.on_message((topic, payload) => void handle(topic, payload).catch((error: unknown) => log(`Home Assistant: ${String(error)}`)));
    const stop_listening = options.readings.subscribe((changed) => void publish_states(changed).catch(() => {}));

    try {
      await publish(topics.availability, "online", true);
      const entities = await options.readings.refresh();
      await publish_configs(entities);
      await publish_states(entities);
      await session.subscribe([`${topics.discovery_prefix}/status`, `${topics.base}/+/set`, `${topics.discovery_prefix}/+/${topics.node}/+/config`]);
      set_status({ state: "connected", error: null, connected_at: new Date().toISOString() });
      while (mine === generation && !link.dropped) {
        await pause(Math.max(1, settings.interval));
        if (mine !== generation || link.dropped) break;
        const entities = await options.readings.refresh();
        await publish_configs(entities);
        await publish_states(entities);
      }
      if (link.dropped) throw link.dropped;
      await publish(topics.availability, "offline", true).catch(() => {});
    } finally {
      stop_listening();
    }
  }

  async function run(mine: number): Promise<void> {
    let delay = backoff_seconds.min;
    while (mine === generation) {
      const settings = options.settings();
      if (!settings.enabled || !settings.broker) {
        set_status({ state: "off", broker: null, error: null, base_topic: null, entities: 0, connected_at: null });
        return;
      }
      const device = options.device();
      const topics = topics_for(settings, device);
      set_status({ state: "connecting", broker: settings.broker, base_topic: topics.base, connected_at: null });
      let session: MqttSession | null = null;
      try {
        session = await connect({
          url: settings.broker,
          client_id: `${topics.node}_${Math.random().toString(16).slice(2, 8)}`,
          username: settings.username || null,
          password: settings.password || null,
          will: { topic: topics.availability, payload: "offline" },
        });
        if (mine !== generation) break;
        await serve(session, settings, topics, mine);
        delay = backoff_seconds.min;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Home Assistant: ${message}; trying again in ${delay} s`);
        set_status({ state: "waiting", error: message, connected_at: null });
      } finally {
        await session?.end().catch(() => {});
      }
      if (mine !== generation) break;
      await pause(delay);
      delay = Math.min(delay * 2, backoff_seconds.max);
    }
  }

  function begin(): void {
    const mine = ++generation;
    wake?.();
    const previous = running ?? Promise.resolve();
    running = previous.then(() => run(mine)).catch((error: unknown) => log(`Home Assistant: ${String(error)}`));
  }

  return {
    start: begin,
    restart: begin,
    status: () => current,
    async stop() {
      generation++;
      wake?.();
      await running;
      set_status({ state: "off", entities: 0, connected_at: null });
    },
  };
}
