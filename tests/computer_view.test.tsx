// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import type { EntityView, HomeAssistantStatus } from "../src/shared/computer/model.ts";
import type { PageApi } from "../src/shared/page_api.ts";
import { set_page_api } from "../src/web/api.ts";
import { ComputerView, home_assistant_summary, reading_text } from "../src/web/computer/ComputerView.tsx";

// ── Setup ────────────────────────────────────────────────────────────────────

function entity(overrides: Partial<EntityView> & Pick<EntityView, "id" | "name" | "kind">): EntityView {
  return { plugin_id: overrides.id.split(".")[0]!, icon: null, unit: null, device_class: null, category: null, options: null, min: null, max: null, step: null, value: null, attributes: null, error: null, read_at: "2026-11-25T10:00:00.000Z", ...overrides };
}

const off: HomeAssistantStatus = { state: "off", broker: null, error: null, base_topic: null, entities: 0, connected_at: null };

let calls: Record<string, ReturnType<typeof vi.fn>>;

function use_readings(readings: EntityView[], status: HomeAssistantStatus = off): void {
  calls = {
    list_readings: vi.fn(async () => readings),
    set_control: vi.fn(async (id: string) => readings.find((found) => found.id === id)),
    get_home_assistant_status: vi.fn(async () => status),
    get_this_device: vi.fn(async () => ({ id: "b".repeat(32), name: "Desk", type: "desktop", tcp_port: 1716, fingerprint: "CC:DD", discovery: true, bluetooth: { state: "waiting", error: "another app holds it" } })),
  };
  set_page_api({ host: "web", calls: calls as unknown as PageApi["calls"], device: null, on_change: () => () => {} });
}

afterEach(cleanup);

// ── Values ───────────────────────────────────────────────────────────────────

describe("readings as text", () => {
  test("shows each kind of value as people read it", () => {
    const base = { kind: "sensor" as const, device_class: null, unit: null, error: null };
    expect(reading_text({ ...base, value: 42.25, unit: "%" })).toBe("42.3 %");
    expect(reading_text({ ...base, value: 7, unit: "°C" })).toBe("7 °C");
    expect(reading_text({ ...base, value: true })).toBe("Yes");
    expect(reading_text({ ...base, value: null })).toBe("Unknown");
    expect(reading_text({ ...base, value: 30, device_class: "duration" })).toBe("30 s");
    expect(reading_text({ ...base, value: 5, error: "no such file" })).toBe("Failed");
  });

  test("sums up the link to Home Assistant", () => {
    expect(home_assistant_summary(off)).toMatch(/Not linked/);
    expect(home_assistant_summary({ ...off, state: "connected", broker: "mqtt://ha:1883", base_topic: "x-control/b", entities: 12 })).toBe("Linked to Home Assistant through mqtt://ha:1883: 12 entities under x-control/b.");
    expect(home_assistant_summary({ ...off, state: "waiting", broker: "mqtt://ha:1883", error: "refused" })).toBe("Waiting to try again: mqtt://ha:1883 (refused).");
  });
});

// ── Page ─────────────────────────────────────────────────────────────────────

describe("the This computer page", () => {
  test("groups readings by plugin and works its controls", async () => {
    use_readings([
      entity({ id: "processor.usage", name: "Processor usage", kind: "sensor", value: 12.5, unit: "%" }),
      entity({ id: "power.shutdown", name: "Shut down", kind: "button" }),
      entity({ id: "power.keep_awake", name: "Keep awake", kind: "switch", value: false }),
      entity({ id: "power.profile", name: "Power profile", kind: "select", options: ["balanced", "performance"], value: "balanced" }),
    ]);
    render(
      <>
        <ComputerView />
        <Dialogs />
      </>,
    );
    expect(await screen.findByText("Processor and memory")).toBeTruthy();
    expect(screen.getByText("12.5 %")).toBeTruthy();
    expect(screen.getByText("Power")).toBeTruthy();
    expect(await screen.findByText(/Desk · Not linked/)).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Keep awake" }));
    expect(calls.set_control).toHaveBeenCalledWith("power.keep_awake", true);

    // Shutting down asks first.
    fireEvent.click(screen.getByRole("button", { name: "Shut down" }));
    expect(calls.set_control).not.toHaveBeenCalledWith("power.shutdown", null);
    const confirm = await screen.findAllByRole("button", { name: "Shut down" });
    fireEvent.click(confirm.at(-1)!);
    await vi.waitFor(() => expect(calls.set_control).toHaveBeenCalledWith("power.shutdown", null));
  });

  test("says what to turn on when nothing is read", async () => {
    use_readings([]);
    render(<ComputerView />);
    expect(await screen.findByText("Nothing to read")).toBeTruthy();
  });
});
