// Settings → System Bridge: the server Home Assistant's System Bridge integration reaches this computer through, its
// port, how it stands, and the keys and pairing codes clients sign in with.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { CommitInput, NumberField, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog, text_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";

import type { SystemBridgeStatus } from "../../shared/system_bridge/api.ts";
import { attempt, calls, set_setting, use_data } from "../api.ts";

// ── Status ───────────────────────────────────────────────────────────────────

export function system_bridge_summary(status: SystemBridgeStatus): string {
  if (status.state === "off") return "Off";
  if (status.state === "failed") return `Could not listen on port ${status.port}: ${status.error}`;
  const clients = status.clients === 1 ? "1 client signed in" : `${status.clients} clients signed in`;
  return `Listening on port ${status.port}, ${clients}.`;
}

function StatusRow() {
  const status = use_data((api) => api.get_system_bridge_status());
  return status.data ? (
    <SettingRow label="Status" hint={`Clients know this computer as ${status.data.uuid}.`}>
      <span>{system_bridge_summary(status.data)}</span>
    </SettingRow>
  ) : null;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

function Keys() {
  const keys = use_data((api) => api.list_system_bridge_keys());
  const [name, set_name] = useState("Home Assistant");
  const create = async (): Promise<void> => {
    const made = await attempt(() => calls().create_system_bridge_key(name));
    if (made) text_dialog(`Key for ${made.view.name}`, `${made.key}\n\nCopy it now: it is not shown again. In Home Assistant, add the System Bridge integration with this computer's address and paste the key as the token.`);
  };
  const pair = async (): Promise<void> => {
    const code = await attempt(() => calls().create_system_bridge_pairing_code());
    if (code) text_dialog("Pairing code", `${code.code}\n\nType it as the token when Home Assistant asks; it works once, until ${new Date(code.expires_at).toLocaleTimeString()}.`);
  };
  const remove = (id: string, label: string): void =>
    confirm_dialog({ title: `Remove the key for ${label}?`, message: "The client using it can no longer sign in.", confirm_label: "Remove", danger: true, run: () => calls().remove_system_bridge_key(id) });
  return (
    <>
      <SettingRow label="Pair a client" hint="A code Home Assistant trades for a key of its own, good for ten minutes.">
        <button type="button" onClick={() => void pair()}>
          Make a pairing code
        </button>
      </SettingRow>
      <SettingRow label="New key" hint="A key to paste into a client by hand.">
        <div className="button-list">
          <CommitInput aria-label="Key for" value={name} on_commit={(event) => set_name(event.currentTarget.value)} />
          <button type="button" onClick={() => void create()}>
            Make a key
          </button>
        </div>
      </SettingRow>
      {(keys.data ?? []).map((key) => (
        <SettingRow key={key.id} label={key.name} hint={`Made ${new Date(key.created_at).toLocaleString()}.`}>
          <button type="button" onClick={() => remove(key.id, key.name)}>
            Remove
          </button>
        </SettingRow>
      ))}
    </>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

// The switch and port as the server runs, since the server's config file can turn it on where Settings says nothing.
function RunRows({ settings }: { settings: Record<string, unknown> }) {
  const status = use_data((api) => api.get_system_bridge_status());
  const running = status.data ? status.data.state !== "off" : settings["system_bridge.enabled"] === true;
  const port = status.data?.port ?? (Number(settings["system_bridge.port"]) || 9170);
  return (
    <>
      <SettingRow label="Run System Bridge" hint="Clients sign in with a key or a pairing code from below." as_label>
        <Switch label="Run System Bridge" checked={running} on_change={(on) => void set_setting("system_bridge.enabled", on)} />
      </SettingRow>
      <SettingRow label="Port" hint="System Bridge's own is 9170.">
        <NumberField label="Port" bare min={1024} max={65_535} value={port} on_change={(next) => void set_setting("system_bridge.port", next ?? 9170)} />
      </SettingRow>
    </>
  );
}

export function system_bridge_section(settings: Record<string, unknown>): SettingsSection {
  return {
    id: "system-bridge",
    heading: "System Bridge",
    hint: "Let Home Assistant's System Bridge integration read and control this computer, as the System Bridge app does. Home Assistant finds it on the network.",
    content: (
      <>
        <RunRows settings={settings} />
        <StatusRow />
        <Keys />
      </>
    ),
  };
}
