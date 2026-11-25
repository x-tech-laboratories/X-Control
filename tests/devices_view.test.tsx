// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import type { DeviceView } from "../src/shared/devices/model.ts";
import type { PageApi } from "../src/shared/page_api.ts";
import { set_page_api } from "../src/web/api.ts";
import { CommandsView } from "../src/web/commands/CommandsView.tsx";
import { DeviceDetail } from "../src/web/devices/DeviceView.tsx";
import { DevicesView } from "../src/web/devices/DevicesView.tsx";
import { forget_page_plugins } from "../src/web/plugins.tsx";

// ── Setup ────────────────────────────────────────────────────────────────────

function device(overrides: Partial<DeviceView>): DeviceView {
  return {
    id: "a".repeat(32),
    name: "Phone",
    type: "phone",
    pair_state: "paired",
    is_connected: true,
    address: "10.0.0.2",
    incoming: ["kdeconnect.share.request", "kdeconnect.clipboard", "kdeconnect.ping", "kdeconnect.findmyphone.request"],
    outgoing: ["kdeconnect.notification"],
    verification_key: null,
    fingerprint: "AA:BB",
    paired_at: "2026-11-25T10:00:00.000Z",
    last_seen: null,
    plugins: {},
    ...overrides,
  };
}

let calls: Record<string, ReturnType<typeof vi.fn>>;

function use_devices(devices: DeviceView[]): void {
  calls = {
    list_devices: vi.fn(async () => devices),
    get_device: vi.fn(async (id: string) => devices.find((found) => found.id === id)),
    list_device_actions: vi.fn(async () => [
      { id: "ping.send", plugin_id: "ping", label: "Ping", description: "Pings it." },
      { id: "findmyphone.ring", plugin_id: "findmyphone", label: "Ring", description: "Rings it." },
    ]),
    get_this_device: vi.fn(async () => ({ id: "b".repeat(32), name: "Laptop", type: "laptop", tcp_port: 1716, fingerprint: "CC:DD", discovery: true })),
    accept_pairing: vi.fn(async () => undefined),
    run_device_action: vi.fn(async () => undefined),
    get_settings: vi.fn(async () => ({ plugins: {} })),
    set_setting: vi.fn(async () => undefined),
    list_commands: vi.fn(async () => [{ id: "c1", name: "Lock", command: "loginctl lock-session", position: 0 }]),
  };
  set_page_api({ host: "web", calls: calls as unknown as PageApi["calls"], device: null, on_change: () => () => {} });
}

beforeEach(() => forget_page_plugins());
afterEach(cleanup);

// ── Devices ──────────────────────────────────────────────────────────────────

describe("the Devices page", () => {
  test("lists each device with its pairing and battery, and this device", async () => {
    use_devices([device({ plugins: { battery: { charge: 80, is_charging: true } } })]);
    render(<DevicesView />);
    expect(await screen.findByText("Phone")).toBeTruthy();
    expect(screen.getByText("Paired")).toBeTruthy();
    expect(screen.getByText(/battery 80% charging/)).toBeTruthy();
    expect(await screen.findByText("This device")).toBeTruthy();
  });

  test("shows a request to pair with its key, and accepts it", async () => {
    use_devices([device({ pair_state: "incoming", verification_key: "ABCD1234" })]);
    render(<DevicesView />);
    expect(await screen.findByText("ABCD1234")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(calls.accept_pairing).toHaveBeenCalledWith("a".repeat(32));
  });
});

describe("a device's page", () => {
  test("offers its quick actions and runs one", async () => {
    use_devices([device({})]);
    render(<DeviceDetail id={"a".repeat(32)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ring" }));
    expect(calls.run_device_action).toHaveBeenCalledWith("a".repeat(32), "findmyphone.ring", {});
  });

  test("shows the plugins' panels and acts through them", async () => {
    const notification = { id: "n1", app: "Messages", title: "Alex", text: "Hello", time: Date.now(), is_clearable: true, actions: [], reply_id: "r1" };
    use_devices([device({ plugins: { battery: { charge: 42, is_charging: false }, notification: { notifications: [notification] } } })]);
    render(<DeviceDetail id={"a".repeat(32)} />);
    expect(await screen.findByText("42%")).toBeTruthy();
    expect(screen.getByText("Hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(calls.run_device_action).toHaveBeenCalledWith("a".repeat(32), "notification.dismiss", { id: "n1" });

    fireEvent.change(screen.getByRole("textbox", { name: "A link to open on the device" }), { target: { value: "https://example.org/" } });
    fireEvent.click(screen.getByRole("button", { name: "Send link" }));
    expect(calls.run_device_action).toHaveBeenCalledWith("a".repeat(32), "share.url", { url: "https://example.org/" });
  });

  test("offers pairing to a connected device that is not paired", async () => {
    use_devices([device({ pair_state: "unpaired" })]);
    render(<DeviceDetail id={"a".repeat(32)} />);
    expect(await screen.findByRole("button", { name: "Pair" })).toBeTruthy();
  });
});

describe("the Commands page", () => {
  test("lists the commands and asks before removing one", async () => {
    use_devices([]);
    render(
      <>
        <CommandsView />
        <Dialogs />
      </>,
    );
    expect(await screen.findByText("loginctl lock-session")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Lock" }));
    expect(await screen.findByText("Remove Lock?")).toBeTruthy();
  });
});
