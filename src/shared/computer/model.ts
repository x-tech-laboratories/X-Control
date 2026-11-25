// What the page and other programs see of the computer the daemon runs on: each reading and control its plugins
// offer, such as the processor's load or a shutdown button, and how the link to Home Assistant stands.

// ── Entities ─────────────────────────────────────────────────────────────────

// The kinds Home Assistant knows over MQTT: a reading, an on or off reading, and the controls.
export type EntityKind = "sensor" | "binary_sensor" | "switch" | "button" | "number" | "select" | "text";

export type ReadingValue = number | string | boolean | null;

export interface EntityView {
  // The plugin's id and the entity's own, such as "processor.usage".
  id: string;
  plugin_id: string;
  name: string;
  kind: EntityKind;
  // A Material Design icon as Home Assistant names it, such as "mdi:cpu-64-bit".
  icon: string | null;
  unit: string | null;
  // Home Assistant's device class, such as "temperature" or "data_size".
  device_class: string | null;
  // Settings and diagnostics are drawn apart from the main readings.
  category: "diagnostic" | "config" | null;
  // A select's choices, and a number's range.
  options: string[] | null;
  min: number | null;
  max: number | null;
  step: number | null;
  value: ReadingValue;
  // More about the reading, such as each processor core's load.
  attributes: Record<string, unknown> | null;
  // Why the last read failed, if it did.
  error: string | null;
  // When it was last read, as an ISO 8601 timestamp.
  read_at: string | null;
}

// ── Home Assistant ───────────────────────────────────────────────────────────

export type BridgeState = "off" | "connecting" | "connected" | "waiting";

export interface HomeAssistantStatus {
  state: BridgeState;
  // The broker in use, such as "mqtt://homeassistant.local:1883".
  broker: string | null;
  // Why the last connection failed, while it waits to try again.
  error: string | null;
  // The topic this computer's readings are published under.
  base_topic: string | null;
  entities: number;
  connected_at: string | null;
}
