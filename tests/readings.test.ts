import { describe, expect, test } from "vitest";

import { create_readings, value_for } from "../src/server/computer/readings.ts";
import type { Entity } from "../src/server/plugins/api.ts";
import { rate_tracker, shared_reading } from "../src/server/plugins/helpers.ts";

function source(plugin_id: string, entities: () => Entity[]) {
  return { plugin_id, value: { list: entities } };
}

describe("readings", () => {
  test("reads every entity, keeps errors apart, and tells listeners what changed", async () => {
    let load = 10;
    let lists = 0;
    const readings = create_readings({
      sources: () => [
        source("processor", () => {
          lists++;
          return [
            { id: "usage", name: "Usage", kind: "sensor", unit: "%", read: () => ({ value: load, attributes: { cores: 4 } }) },
            { id: "broken", name: "Broken", kind: "sensor", read: () => Promise.reject(new Error("no such file")) },
          ];
        }),
      ],
      interval: () => 0,
    });
    const heard: string[][] = [];
    readings.subscribe((changed) => heard.push(changed.map((entity) => `${entity.id}=${String(entity.value)}`)));
    const first = await readings.refresh();
    expect(first.map((entity) => [entity.id, entity.value, entity.error])).toEqual([
      ["processor.usage", 10, null],
      ["processor.broken", null, "no such file"],
    ]);
    expect(first[0]).toMatchObject({ attributes: { cores: 4 }, unit: "%", plugin_id: "processor" });
    load = 20;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await readings.refresh();
    expect(heard).toEqual([["processor.usage=10", "processor.broken=null"], ["processor.usage=20"]]);
    // Listed once, until a plugin changes.
    expect(lists).toBe(1);
    readings.forget_list();
    await readings.refresh();
    expect(lists).toBe(2);
  });

  test("waits out an entity's own interval, and fails a read that hangs", async () => {
    let slow_reads = 0;
    const readings = create_readings({
      sources: () => [
        source("disks", () => [
          { id: "used", name: "Used", kind: "sensor", every: 3600, read: () => ++slow_reads },
          { id: "stuck", name: "Stuck", kind: "sensor", read: () => new Promise(() => {}) },
        ]),
      ],
      interval: () => 1,
      timeout_ms: 50,
    });
    const views = await readings.refresh();
    await readings.refresh();
    expect(slow_reads).toBe(1);
    expect(views.find((entity) => entity.id === "disks.stuck")?.error).toMatch(/no answer/);
  });

  test("sets controls with the value their kind takes, and refuses readings and unknown ids", async () => {
    const set: unknown[] = [];
    let on = false;
    const readings = create_readings({
      sources: () => [
        source("power", () => [
          { id: "awake", name: "Keep awake", kind: "switch", read: () => on, set: (value) => void (on = value === true) },
          { id: "profile", name: "Profile", kind: "select", options: ["balanced", "performance"], read: () => "balanced", set: (value) => void set.push(value) },
          { id: "shutdown", name: "Shut down", kind: "button", set: (value) => void set.push(["pressed", value]) },
          { id: "battery", name: "Battery", kind: "sensor", read: () => 50 },
        ]),
      ],
      interval: () => 10,
    });
    expect((await readings.set("power.awake", "ON")).value).toBe(true);
    await readings.set("power.profile", "performance");
    await readings.set("power.shutdown", "PRESS");
    expect(set).toEqual(["performance", ["pressed", null]]);
    await expect(readings.set("power.profile", "turbo")).rejects.toThrow(/one of balanced, performance/);
    await expect(readings.set("power.battery", 10)).rejects.toThrow(/cannot be set/);
    await expect(readings.set("power.nothing", 1)).rejects.toThrow(/No reading or control/);
  });

  test("reads values as each kind takes them", () => {
    expect(value_for("switch", "off")).toBe(false);
    expect(value_for("number", "42", { min: 0, max: 100 })).toBe(42);
    expect(() => value_for("number", "200", { min: 0, max: 100 })).toThrow(/from 0 to 100/);
    expect(() => value_for("number", "many")).toThrow(/number/);
    expect(() => value_for("switch", "maybe")).toThrow(/on or off/);
    expect(value_for("text", null)).toBe("");
  });
});

describe("reading helpers", () => {
  test("works out rates between readings of a counter", () => {
    const rate = rate_tracker();
    expect(rate("eth0", 1000, 0)).toBeNull();
    expect(rate("eth0", 3000, 2000)).toBe(1000);
    // A counter that starts again gives no rate.
    expect(rate("eth0", 10, 3000)).toBeNull();
  });

  test("shares one reading until it is forgotten", async () => {
    let reads = 0;
    const read = shared_reading(async () => ++reads);
    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    read.forget();
    expect(await read()).toBe(2);
  });
});
