// Settings: this device's name, history, which notifications show, the link to Home Assistant, the System Bridge
// server, the plugins, import and export, and the sections of whichever host the page runs on: connections on a
// phone, sync, backups, MCP and the desktop's own settings.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState, type ReactNode } from "react";
import { BackupSettings } from "@x-tech-laboratories/x-libs/web/react/backup_settings";
import { TrustedCertificates } from "@x-tech-laboratories/x-libs/web/react/certificates";
import { ConnectionSettings } from "@x-tech-laboratories/x-libs/web/react/connections";
import { CommitInput, NumberField, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { LocalMcpSettings } from "@x-tech-laboratories/x-libs/web/react/local_mcp_settings";
import { PageHeading, SettingRow, SettingsPage, type SettingsCategory, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { PeerListeningSettings, SyncSettings } from "@x-tech-laboratories/x-libs/web/react/sync_settings";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import type { DesktopSettings } from "../../shared/desktop.ts";
import { notice_kinds, notice_setting } from "../../shared/notices.ts";
import { attempt, calls, data_watch, page, set_setting, show_error, succeeds, use_data, use_settings } from "../api.ts";
import { home_assistant_summary } from "../computer/ComputerView.tsx";
import { PluginRows } from "../plugins.tsx";
import { system_bridge_section } from "./SystemBridgeSettings.tsx";

// ── Files ────────────────────────────────────────────────────────────────────

// Hands the browser a file to save.
function save_file(name: string, text: string, type: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// A button that asks for a file and hands over its text.
function FileButton({ label, accept, on_text }: { label: string; accept: string; on_text: (text: string) => void }) {
  return (
    <label className="button file-button">
      {label}
      <input type="file" accept={accept} className="visually-hidden" onChange={(event) => void event.currentTarget.files?.[0]?.text().then(on_text)} />
    </label>
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Sections ─────────────────────────────────────────────────────────────────

function ThisDeviceName() {
  const device = use_data((api) => api.get_this_device());
  return (
    <Loaded resource={device}>
      {(found) => (
        <SettingRow label="Name" hint="What other devices show for this one.">
          <CommitInput aria-label="Name" value={found.name} on_commit={(event) => void succeeds(() => calls().rename_this_device(event.currentTarget.value), "Renamed.")} />
        </SettingRow>
      )}
    </Loaded>
  );
}

function notifications_section(settings: Record<string, unknown>): SettingsSection {
  return {
    id: "notifications",
    heading: "Notifications",
    hint: "What this device tells you while X-Control is closed.",
    content: (
      <>
        {notice_kinds.map((entry) => (
          <SettingRow key={entry.kind} label={entry.label} hint={entry.hint} as_label>
            <Switch label={entry.label} checked={settings[notice_setting(entry.kind)] !== false} on_change={(on) => void set_setting(notice_setting(entry.kind), on)} />
          </SettingRow>
        ))}
      </>
    ),
  };
}

// This computer's link to Home Assistant over MQTT, with how it stands now.
function HomeAssistantStatusRow() {
  const status = use_data((api) => api.get_home_assistant_status());
  return status.data ? (
    <SettingRow label="Status" hint="Home Assistant lists the entities under a device named after this computer.">
      <span>{status.data.state === "off" ? "Off" : home_assistant_summary(status.data)}</span>
    </SettingRow>
  ) : null;
}

function home_assistant_section(settings: Record<string, unknown>): SettingsSection {
  const text = (key: string): string => (typeof settings[key] === "string" ? (settings[key] as string) : "");
  const field = (key: string, label: string, hint: string, placeholder: string, type = "text"): ReactNode => (
    <SettingRow label={label} hint={hint}>
      <CommitInput aria-label={label} type={type} autoComplete={type === "password" ? "new-password" : "off"} placeholder={placeholder} value={text(key)} on_commit={(event) => void set_setting(key, event.currentTarget.value.trim())} />
    </SettingRow>
  );
  return {
    id: "home-assistant",
    heading: "Home Assistant",
    hint: "Publish this computer's readings and controls, under This computer, to Home Assistant over MQTT, as LNXlink does. Each computer links on its own.",
    content: (
      <>
        <SettingRow label="Link to Home Assistant" hint="Needs Home Assistant's MQTT integration and a broker, such as the Mosquitto add-on." as_label>
          <Switch label="Link to Home Assistant" checked={settings["home_assistant.enabled"] === true} on_change={(on) => void set_setting("home_assistant.enabled", on)} />
        </SettingRow>
        {field("home_assistant.broker", "Broker", "The broker's address, as mqtt:// or mqtts:// with its port.", "mqtt://homeassistant.local:1883")}
        {field("home_assistant.username", "Name", "The name X-Control signs in to the broker with.", "")}
        {field("home_assistant.password", "Password", "Kept on this computer and never shown again.", "", "password")}
        {field("home_assistant.discovery_prefix", "Discovery prefix", "The topic Home Assistant reads MQTT discovery from.", "homeassistant")}
        {field("home_assistant.base_topic", "Base topic", "The topic readings are published under, followed by this computer's id.", "x-control")}
        <SettingRow label="Read every" hint="How often readings are taken and published.">
          <NumberField label="Read every" bare unit="seconds" min={1} value={Number(settings["home_assistant.interval"]) || 10} on_change={(seconds) => void set_setting("home_assistant.interval", seconds ?? 10)} />
        </SettingRow>
        <HomeAssistantStatusRow />
      </>
    ),
  };
}

// Imports run commands after the user picks which copy wins where a command differs.
async function import_commands(file: string): Promise<void> {
  const preview = await attempt(() => calls().lookup_command_import(file));
  if (!preview) return;
  const finish = async (differing: "mine" | "theirs"): Promise<void> => {
    const report = await attempt(() => calls().import_commands(file, differing));
    if (report) toast(`${report.added} added, ${report.replaced} replaced, ${report.kept} kept as they were.`, { tone: "good" });
  };
  if (preview.differing.length === 0) return finish("mine");
  confirm_dialog({
    title: "Replace commands that differ?",
    message: `${preview.differing.length} of the file's commands differ from the ones kept here: ${preview.differing.map((entry) => entry.kept.name).join(", ")}. Replace them with the file's, or keep yours. ${preview.added.length} new ones are added either way.`,
    confirm_label: "Use the file's",
    run: () => finish("theirs"),
  });
}

function import_export_section(): SettingsSection {
  const export_commands = async (format: "json" | "csv"): Promise<void> => {
    const text = await attempt(() => calls().export_commands(format));
    if (text !== undefined) save_file(`x-control-commands-${today()}.${format}`, text, format === "json" ? "application/json" : "text/csv");
  };
  return {
    id: "import-export",
    heading: "Import and export",
    hint: "Take your run commands and settings to another X-Control, or bring them back.",
    content: (
      <>
        <SettingRow label="Run commands" hint="As X-Control's JSON or as CSV.">
          <div className="button-list">
            <button type="button" onClick={() => void export_commands("json")}>Export JSON</button>
            <button type="button" onClick={() => void export_commands("csv")}>Export CSV</button>
            <FileButton label="Import" accept=".json,.csv,application/json,text/csv" on_text={(text) => void import_commands(text)} />
          </div>
        </SettingRow>
        <SettingRow label="Settings" hint="Every setting but those of this device alone, such as its notifications.">
          <div className="button-list">
            <button type="button" onClick={() => void attempt(() => calls().export_settings()).then((file) => file && save_file(`x-control-settings-${today()}.json`, JSON.stringify(file, null, 2), "application/json"))}>
              Export
            </button>
            <FileButton label="Import" accept=".json,application/json" on_text={(text) => void attempt(() => calls().import_settings(text)).then((result) => result && toast(`${result.changed} settings set.`, { tone: "good" }))} />
          </div>
        </SettingRow>
      </>
    ),
  };
}

// ── Host sections ────────────────────────────────────────────────────────────

// The desktop app's own settings, which belong to this computer and do not sync.
function Desktop() {
  const { desktop } = page();
  const [settings, set_settings] = useState<DesktopSettings | null>(null);
  useEffect(() => void desktop?.get_desktop_settings().then(set_settings, show_error), [desktop]);
  if (!desktop || !settings) return null;
  const change = (key: keyof DesktopSettings, on: boolean): void => {
    set_settings({ ...settings, [key]: on });
    void desktop.set_desktop_setting(key, on).catch(show_error);
  };
  const row = (key: keyof DesktopSettings, label: string, hint: string, disabled = false): ReactNode => (
    <SettingRow label={label} hint={hint} as_label>
      <Switch label={label} checked={settings[key]} disabled={disabled} on_change={(on) => change(key, on)} />
    </SettingRow>
  );
  return (
    <>
      {row("show_tray_icon", "Show tray icon", "An icon in the system tray lists your devices and brings the window back.")}
      {row("keep_running_in_background", "Keep running in the background", "Devices stay connected, and notifications, sync and backups carry on, with the window closed.")}
      {row("start_at_login", "Start at login", "Starts X-Control in the background when you log in.", !settings.keep_running_in_background)}
      <SettingRow label="Quit completely" hint="Closes the window and stops X-Control in the background too, until you open it again.">
        <button type="button" onClick={() => void desktop.quit_completely().catch(show_error)}>Quit completely</button>
      </SettingRow>
    </>
  );
}

function host_category(): SettingsCategory[] {
  const { device, server_sync, backups, certificates, listening, local_mcp, desktop, connections } = page();
  const sections: SettingsSection[] = [
    ...(connections ? [{ id: "connections", heading: "Connections", hint: "The X-Control daemons this phone controls devices through.", content: <ConnectionSettings client={connections} certificates={certificates} placeholder="https://control.example.org/" /> }] : []),
    ...(device
      ? [{ id: "sync", heading: "Sync", hint: "Keep run commands and settings alike with your other X-Control daemons.", content: <>
          <SyncSettings device={device} subscribe={data_watch.subscribe} data_name="X-Control data" extra={listening && <PeerListeningSettings listening={listening} />} />
          {certificates && <TrustedCertificates certificates={certificates} />}
        </> }]
      : []),
    ...(server_sync && !connections ? [{ id: "sync", heading: "Sync", hint: "Keep the server's run commands and settings alike with your other daemons. Only an admin may pair or remove a device.", content: <SyncSettings device={server_sync} subscribe={data_watch.subscribe} data_name="X-Control data" /> }] : []),
    ...(backups ? [{ id: "backups", heading: "Backups", hint: device ? "Copies of this device's data, kept beside it." : "Copies of the daemon's data. A restore restarts the server.", content: <BackupSettings device={backups} data_name="X-Control data" on_restored={() => data_watch.bump()} /> }] : []),
    ...(local_mcp ? [{ id: "mcp", heading: "MCP server", hint: "Let AI assistants on this computer reach your devices.", content: <LocalMcpSettings device={local_mcp} name="x-control" data_name="see and control your paired devices" /> }] : []),
    ...(desktop ? [{ id: "desktop", heading: "Desktop", hint: "The tray icon, and what runs while the window is closed.", content: <Desktop /> }] : []),
  ];
  return sections.length ? [{ heading: device ? "This device" : "Server", sections }] : [];
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function SettingsView({ server_sections = [] }: { server_sections?: SettingsSection[] }) {
  const settings = use_settings();
  return (
    <>
      <PageHeading title="Settings" />
      <Loaded resource={settings}>
        {(values) => (
          <SettingsPage
            categories={[
              {
                heading: "General",
                sections: [
                  { id: "this-device", heading: "This device", content: <ThisDeviceName /> },
                  {
                    id: "history",
                    heading: "History",
                    hint: "Every change to a run command is kept, to look back on or restore under History.",
                    content: (
                      <SettingRow label="Keep changes for" hint="Older changes are pruned; each command always keeps its latest.">
                        <NumberField label="Keep changes for" bare unit="days" min={1} value={Number(values["history.keep_days"])} on_change={(days) => void set_setting("history.keep_days", days ?? 180)} />
                      </SettingRow>
                    ),
                  },
                  notifications_section(values),
                  home_assistant_section(values),
                  system_bridge_section(values),
                  { id: "plugins", heading: "Plugins", hint: "What X-Control does with your devices; turn off what you do not want. Plugins from the plugins folder run with X-Control's full rights.", content: <PluginRows /> },
                  import_export_section(),
                ],
              },
              ...host_category(),
              ...(server_sections.length ? [{ heading: "Users", sections: server_sections }] : []),
            ]}
          />
        )}
      </Loaded>
    </>
  );
}
