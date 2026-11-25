import { createServer, type AddressInfo, type Server } from "node:net";

import { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { afterEach, describe, expect, test } from "vitest";

import type { EntityView } from "../src/shared/computer/model.ts";
import { create_readings } from "../src/server/computer/readings.ts";
import { create_home_assistant_bridge, default_home_assistant_settings, entity_config, payload_of, topics_for, type HomeAssistantBridge, type HomeAssistantSettings } from "../src/server/home_assistant/bridge.ts";
import type { Entity } from "../src/server/plugins/api.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A broker in this process on a free port, as Home Assistant's Mosquitto add-on would be.
async function start_broker(): Promise<string> {
  const broker = await Aedes.createBroker();
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => broker.close(() => server.close(() => resolve()))));
  return `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Home Assistant's side: every message it hears, retained ones included, by topic.
async function listen(url: string): Promise<{ client: MqttClient; heard: Map<string, string>; wait_for: (topic: string, value?: (payload: string) => boolean) => Promise<string> }> {
  const client = await mqtt.connectAsync(url, { reconnectPeriod: 0 });
  cleanups.push(() => client.endAsync());
  const heard = new Map<string, string>();
  client.on("message", (topic, payload) => heard.set(topic, payload.toString()));
  await client.subscribeAsync("#");
  const wait_for = async (topic: string, value: (payload: string) => boolean = () => true): Promise<string> => {
    for (let tries = 0; tries < 300; tries++) {
      const payload = heard.get(topic);
      if (payload !== undefined && value(payload)) return payload;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`nothing on ${topic}; heard ${[...heard.keys()].join(", ")}`);
  };
  return { client, heard, wait_for };
}

const device = { id: "0123456789abcdef0123456789abcdef", name: "Desk", version: "0.1.0" };

function start_bridge(url: string, entities: () => Entity[], overrides: Partial<HomeAssistantSettings> = {}): HomeAssistantBridge {
  const readings = create_readings({ sources: () => [{ plugin_id: "power", value: { list: entities } }], interval: () => 1 });
  const settings = { ...default_home_assistant_settings, enabled: true, broker: url, interval: 1, ...overrides };
  const bridge = create_home_assistant_bridge({ readings, settings: () => settings, device: () => device });
  bridge.start();
  cleanups.push(() => bridge.stop());
  return bridge;
}

const topics = topics_for(default_home_assistant_settings, device);

// ── Discovery ────────────────────────────────────────────────────────────────

describe("discovery", () => {
  test("writes each kind's config as Home Assistant reads it", () => {
    const view: EntityView = { id: "power.brightness", plugin_id: "power", name: "Screen brightness", kind: "number", icon: "mdi:brightness-6", unit: "%", device_class: null, category: null, options: null, min: 1, max: 100, step: 1, value: 40, attributes: null, error: null, read_at: null };
    const [topic, config] = entity_config(view, topics, device);
    expect(topic).toBe(`homeassistant/number/${topics.node}/power_brightness/config`);
    expect(config).toMatchObject({
      unique_id: `${topics.node}_power_brightness`,
      state_topic: `x-control/${device.id}/power_brightness/state`,
      command_topic: `x-control/${device.id}/power_brightness/set`,
      availability_topic: `x-control/${device.id}/status`,
      device: { identifiers: [topics.node], name: "Desk", model: "X-Control" },
      min: 1,
      max: 100,
    });
    const [, button] = entity_config({ ...view, id: "power.shutdown", kind: "button" }, topics, device);
    expect(button).not.toHaveProperty("state_topic");
    expect(payload_of({ kind: "switch", value: true })).toBe("ON");
    expect(payload_of({ kind: "sensor", value: null })).toBe("None");
    expect(payload_of({ kind: "text", value: null })).toBe("");
  });
});

// ── Over MQTT ────────────────────────────────────────────────────────────────

describe("over MQTT", () => {
  test("announces entities, publishes their values and works commands from Home Assistant", async () => {
    const url = await start_broker();
    const home = await listen(url);
    let awake = false;
    const pressed: string[] = [];
    const bridge = start_bridge(url, () => [
      { id: "awake", name: "Keep awake", kind: "switch", read: () => awake, set: (on) => void (awake = on === true) },
      { id: "load", name: "Load", kind: "sensor", read: () => ({ value: 1.5, attributes: { cores: 4 } }) },
      { id: "suspend", name: "Suspend", kind: "button", set: () => void pressed.push("suspend") },
    ]);

    expect(await home.wait_for(topics.availability)).toBe("online");
    const config = JSON.parse(await home.wait_for(`homeassistant/switch/${topics.node}/power_awake/config`)) as Record<string, unknown>;
    expect(config.command_topic).toBe(`${topics.base}/power_awake/set`);
    expect(await home.wait_for(`${topics.base}/power_load/state`)).toBe("1.5");
    expect(JSON.parse(await home.wait_for(`${topics.base}/power_load/attributes`))).toEqual({ cores: 4 });
    expect(await home.wait_for(`${topics.base}/power_awake/state`)).toBe("OFF");

    await home.client.publishAsync(`${topics.base}/power_awake/set`, "ON");
    expect(await home.wait_for(`${topics.base}/power_awake/state`, (payload) => payload === "ON")).toBe("ON");
    await home.client.publishAsync(`${topics.base}/power_suspend/set`, "PRESS");
    for (let tries = 0; tries < 100 && pressed.length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pressed).toEqual(["suspend"]);
    expect(bridge.status()).toMatchObject({ state: "connected", entities: 3, broker: url });

    await bridge.stop();
    expect(await home.wait_for(topics.availability, (payload) => payload === "offline")).toBe("offline");
  });

  test("clears the configs of entities that went away, and announces again when Home Assistant restarts", async () => {
    const url = await start_broker();
    const home = await listen(url);
    // A config left by an earlier run, for an entity this one no longer has.
    const stale = `homeassistant/sensor/${topics.node}/power_gone/config`;
    await home.client.publishAsync(stale, JSON.stringify({ name: "Gone" }), { retain: true });
    start_bridge(url, () => [{ id: "battery", name: "Battery", kind: "sensor", read: () => 80 }]);
    const config_topic = `homeassistant/sensor/${topics.node}/power_battery/config`;
    await home.wait_for(config_topic);
    expect(await home.wait_for(stale, (payload) => payload === "")).toBe("");

    home.heard.delete(config_topic);
    await home.client.publishAsync("homeassistant/status", "online");
    expect(JSON.parse(await home.wait_for(config_topic))).toMatchObject({ name: "Battery" });
  });

  test("waits and tries again while the broker cannot be reached", async () => {
    const bridge = start_bridge("mqtt://127.0.0.1:9", () => []);
    for (let tries = 0; tries < 300 && bridge.status().state !== "waiting"; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.status()).toMatchObject({ state: "waiting", broker: "mqtt://127.0.0.1:9" });
    expect(bridge.status().error).toBeTruthy();
  });

  test("stays off until it is turned on", () => {
    const bridge = start_bridge("", () => [], { enabled: false });
    expect(bridge.status().state).toBe("off");
  });
});
