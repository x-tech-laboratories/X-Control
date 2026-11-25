// The Devices page: this device as others see it, requests to pair waiting for an answer, and every device known,
// each a card leading to its own page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type FormEvent } from "react";
import { Badge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Card, Cards, Facts, PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { DeviceView, PairState } from "../../shared/devices/model.ts";
import type { BatteryState } from "../../shared/plugins/states.ts";
import { calls, succeeds, use_data } from "../api.ts";

// ── Words ────────────────────────────────────────────────────────────────────

export const pair_labels: Record<PairState, [string, Tone]> = {
  paired: ["Paired", "good"],
  requested: ["Waiting for an answer", "info"],
  incoming: ["Asks to pair", "warn"],
  unpaired: ["Not paired", "none"],
};

export const type_labels: Record<DeviceView["type"], string> = { desktop: "Desktop", laptop: "Laptop", phone: "Phone", tablet: "Tablet", tv: "TV" };

// What a card says under a device's name: its type, whether it is reachable, and its battery.
export function device_summary(device: DeviceView): string {
  const battery = device.plugins.battery as BatteryState | undefined;
  const parts = [type_labels[device.type], device.is_connected ? "connected" : "not connected"];
  if (battery && battery.charge >= 0) parts.push(`battery ${battery.charge}%${battery.is_charging ? " charging" : ""}`);
  return parts.join(" · ");
}

// ── Pairing requests ─────────────────────────────────────────────────────────

export function PairRequest({ device }: { device: DeviceView }) {
  return (
    <div className="pair-request" role="group" aria-label={`${device.name} asks to pair`}>
      <p>
        <strong>{device.name}</strong> asks to pair. Check that it shows <code className="verification-key">{device.verification_key}</code> too.
      </p>
      <div className="button-list">
        <button type="button" className="accent" onClick={() => void succeeds(() => calls().accept_pairing(device.id), `Paired with ${device.name}.`)}>
          Accept
        </button>
        <button type="button" onClick={() => void succeeds(() => calls().reject_pairing(device.id))}>
          Reject
        </button>
      </div>
    </div>
  );
}

// ── This device ──────────────────────────────────────────────────────────────

function ConnectByAddress() {
  const [address, set_address] = useState("");
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (await succeeds(() => calls().connect_address(address), `Asked ${address} to connect.`)) set_address("");
  };
  return (
    <form className="send-field" onSubmit={(event) => void submit(event)}>
      <input aria-label="Address of a device" placeholder="Address of a device, such as 192.168.1.20" value={address} onChange={(event) => set_address(event.currentTarget.value)} />
      <button type="submit" disabled={!address.trim()}>
        Connect
      </button>
    </form>
  );
}

function ThisDeviceSection() {
  const resource = use_data((api) => api.get_this_device());
  return (
    <Loaded resource={resource}>
      {(device) => (
        <Section title="This device" level={2} tools={<button type="button" onClick={() => void succeeds(() => calls().refresh_devices(), "Told the network about this device.")}>Refresh</button>}>
          <Facts
            rows={[
              ["Name", device.name],
              ["Type", type_labels[device.type]],
              ["Port", device.tcp_port ? String(device.tcp_port) : "Not listening"],
              ["Finding devices", device.discovery ? "On the local network" : "Only by address"],
              ["Fingerprint", <code className="fingerprint">{device.fingerprint}</code>],
            ]}
          />
          <ConnectByAddress />
        </Section>
      )}
    </Loaded>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function DevicesView() {
  const devices = use_data((api) => api.list_devices());
  return (
    <>
      <PageHeading title="Devices" subtitle="Phones, tablets and computers running KDE Connect, Valent, GSConnect or X-Control." />
      <Loaded resource={devices}>
        {(list) => (
          <>
            {list
              .filter((device) => device.pair_state === "incoming")
              .map((device) => (
                <PairRequest key={device.id} device={device} />
              ))}
            {list.length === 0 ? (
              <Empty title="No devices yet" hint="Open KDE Connect or Valent on a device on the same network, or connect to one by its address below." />
            ) : (
              <Cards>
                {list.map((device) => (
                  <Card key={device.id} title={device.name} subtitle={device_summary(device)} href={`#/devices/${device.id}`} badge={<Badge tone={pair_labels[device.pair_state][1]}>{pair_labels[device.pair_state][0]}</Badge>} />
                ))}
              </Cards>
            )}
          </>
        )}
      </Loaded>
      <ThisDeviceSection />
    </>
  );
}
