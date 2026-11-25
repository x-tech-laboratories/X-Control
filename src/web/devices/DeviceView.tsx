// One device's page: whether it is paired and connected, pairing and unpairing, the quick actions its plugins offer,
// such as ringing it, and each plugin's panel, such as its notifications.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Facts, PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { PluginSlot } from "@x-tech-laboratories/x-libs/web/react/plugins";
import { Loaded, Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";

import type { DeviceActionView, DeviceView } from "../../shared/devices/model.ts";
import { calls, succeeds, use_data } from "../api.ts";
import { use_page_plugins } from "../plugins.tsx";
import { device_summary, pair_labels, PairRequest } from "./DevicesView.tsx";

// ── Actions ──────────────────────────────────────────────────────────────────

// Actions that need no words from the user, shown as buttons at the top; the rest live in the plugins' panels.
const quick_actions = ["ping.send", "findmyphone.ring", "clipboard.push", "lock.lock"];

function QuickActions({ device, actions }: { device: DeviceView; actions: DeviceActionView[] }) {
  const shown = actions.filter((action) => quick_actions.includes(action.id));
  if (shown.length === 0 || !device.is_connected) return null;
  return (
    <Toolbar>
      {shown.map((action) => (
        <button key={action.id} type="button" title={action.description} onClick={() => void succeeds(() => calls().run_device_action(device.id, action.id, {}), `${action.label}: done.`)}>
          {action.label}
        </button>
      ))}
    </Toolbar>
  );
}

function PairingButtons({ device }: { device: DeviceView }) {
  if (device.pair_state === "paired") {
    const unpair = () =>
      confirm_dialog({
        title: `Unpair ${device.name}?`,
        message: "It will have to be paired again before it can do anything here.",
        confirm_label: "Unpair",
        danger: true,
        run: async () => void (await calls().unpair_device(device.id)),
      });
    return (
      <button type="button" onClick={unpair}>
        Unpair
      </button>
    );
  }
  if (device.pair_state === "requested") {
    return (
      <button type="button" onClick={() => void succeeds(() => calls().reject_pairing(device.id))}>
        Cancel request
      </button>
    );
  }
  if (device.pair_state === "unpaired" && device.is_connected) {
    return (
      <button type="button" className="accent" onClick={() => void succeeds(() => calls().pair_device(device.id), `Asked ${device.name} to pair.`)}>
        Pair
      </button>
    );
  }
  return null;
}

// ── Panels ───────────────────────────────────────────────────────────────────

function Panels({ device }: { device: DeviceView }) {
  const host = use_page_plugins();
  if (!host) return <Skeleton lines={3} />;
  const run = (plugin_id: string) => (action: string, args: Record<string, unknown> = {}) => calls().run_device_action(device.id, `${plugin_id}.${action}`, args);
  return (
    <div className="device-panels">
      {host.list().map(({ manifest }) => (
        <PluginSlot key={manifest.id} host={host} name="device_panel" plugin_id={manifest.id} props={{ device, run: run(manifest.id) }} />
      ))}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function DeviceDetail({ id }: { id: string }) {
  const resource = use_data(async (api) => {
    const device = await api.get_device(id);
    const actions = device.pair_state === "paired" ? await api.list_device_actions(id) : [];
    return { device, actions };
  }, [id]);
  return (
    <Loaded resource={resource}>
      {({ device, actions }) => (
        <>
          <PageHeading
            title={device.name}
            subtitle={
              <>
                <Badge tone={pair_labels[device.pair_state][1]}>{pair_labels[device.pair_state][0]}</Badge> {device_summary(device)}
              </>
            }
            actions={<PairingButtons device={device} />}
          />
          {device.pair_state === "incoming" && <PairRequest device={device} />}
          {device.pair_state === "requested" && (
            <p>
              Accept the request on {device.name}, checking it shows <code className="verification-key">{device.verification_key}</code>.
            </p>
          )}
          {device.pair_state === "paired" && (
            <>
              <QuickActions device={device} actions={actions} />
              {!device.is_connected && <p className="muted">{device.name} is not connected now; what it last told this computer is shown.</p>}
              <Panels device={device} />
            </>
          )}
          <Facts
            rows={[
              ["Address", device.address ?? "Unknown"],
              ["Paired", device.paired_at ? new Date(device.paired_at).toLocaleString() : "No"],
              ["Fingerprint", device.fingerprint ? <code className="fingerprint">{device.fingerprint}</code> : "Unknown"],
            ]}
          />
        </>
      )}
    </Loaded>
  );
}
