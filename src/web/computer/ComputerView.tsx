// This computer: every reading and control its plugins offer, read again every few seconds while the page is open,
// grouped by plugin with the readings as tiles and the controls as rows.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { format_duration } from "@x-tech-laboratories/x-libs/durations";
import { CommitInput, NumberField, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { PageHeading, Section, SettingRow, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { create_watch } from "@x-tech-laboratories/x-libs/web/watch";

import type { EntityView, HomeAssistantStatus } from "../../shared/computer/model.ts";
import { bundled_manifests } from "../../shared/plugins/manifests.ts";
import { calls, data_watch, succeeds, use_data } from "../api.ts";

// ── Values ───────────────────────────────────────────────────────────────────

// Seconds between readings while the view is open.
const refresh_seconds = 5;

// A reading as the page shows it, such as "42.5 %", "3 hours" or "Yes".
export function reading_text(entity: Pick<EntityView, "value" | "unit" | "device_class" | "kind" | "error">): string {
  const { value } = entity;
  if (entity.error) return "Failed";
  if (value === null || value === "") return "Unknown";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (entity.device_class === "timestamp" && typeof value === "string") return new Date(value).toLocaleString();
  if (entity.device_class === "duration" && typeof value === "number") return value < 60 ? `${value} s` : format_duration(value);
  if (typeof value === "number") return `${Number.isInteger(value) ? value : value.toFixed(1)}${entity.unit ? ` ${entity.unit}` : ""}`;
  return entity.unit ? `${value} ${entity.unit}` : value;
}

function plugin_name(plugin_id: string): string {
  return bundled_manifests.find((manifest) => manifest.id === plugin_id)?.name ?? plugin_id;
}

// Buttons that end the session or stop the computer ask first.
const asks_first = new Set(["power.shutdown", "power.restart", "power.hibernate", "power.suspend"]);

// ── Controls ─────────────────────────────────────────────────────────────────

function set_to(entity: EntityView, value: string | number | boolean | null): void {
  void succeeds(() => calls().set_control(entity.id, value));
}

function Control({ entity }: { entity: EntityView }) {
  if (entity.kind === "button") {
    const press = (): void => {
      if (!asks_first.has(entity.id)) return set_to(entity, null);
      confirm_dialog({ title: `${entity.name}?`, message: `This computer will ${entity.name.toLowerCase()} now.`, confirm_label: entity.name, danger: true, run: () => calls().set_control(entity.id, null).then(() => undefined) });
    };
    return (
      <button type="button" onClick={press}>
        {entity.name}
      </button>
    );
  }
  if (entity.kind === "switch") return <Switch label={entity.name} checked={entity.value === true} on_change={(on) => set_to(entity, on)} />;
  if (entity.kind === "number") {
    return <NumberField label={entity.name} bare value={typeof entity.value === "number" ? entity.value : null} min={entity.min ?? undefined} max={entity.max ?? undefined} step={entity.step ?? undefined} unit={entity.unit ?? undefined} on_change={(value) => value !== null && set_to(entity, value)} />;
  }
  if (entity.kind === "select") {
    const options = (entity.options ?? []).map((option) => [option, option] as [string, string]);
    return <Select label={entity.name} bare options={options} value={typeof entity.value === "string" ? entity.value : ""} on_change={(value) => set_to(entity, value)} />;
  }
  // A text control sends what is typed; one that reads, such as the clipboard, shows it first.
  return <CommitInput aria-label={entity.name} placeholder={entity.name} value={typeof entity.value === "string" ? entity.value : ""} on_commit={(event) => event.currentTarget.value && set_to(entity, event.currentTarget.value)} />;
}

// ── Groups ───────────────────────────────────────────────────────────────────

function Group({ plugin_id, entities }: { plugin_id: string; entities: EntityView[] }) {
  const readings = entities.filter((entity) => entity.kind === "sensor" || entity.kind === "binary_sensor");
  const controls = entities.filter((entity) => entity.kind !== "sensor" && entity.kind !== "binary_sensor");
  const buttons = controls.filter((entity) => entity.kind === "button");
  const rows = controls.filter((entity) => entity.kind !== "button");
  return (
    <Section title={plugin_name(plugin_id)} level={2}>
      {readings.length > 0 && (
        <Tiles>
          {readings.map((entity) => (
            <Tile key={entity.id} label={entity.name} value={<span title={entity.error ?? undefined}>{reading_text(entity)}</span>} tone={entity.error ? "bad" : undefined} />
          ))}
        </Tiles>
      )}
      {rows.map((entity) => (
        <SettingRow key={entity.id} label={entity.name} hint={entity.error ?? undefined}>
          <Control entity={entity} />
        </SettingRow>
      ))}
      {buttons.length > 0 && (
        <div className="button-list">
          {buttons.map((entity) => (
            <Control key={entity.id} entity={entity} />
          ))}
        </div>
      )}
    </Section>
  );
}

// ── Home Assistant ───────────────────────────────────────────────────────────

const bridge_text: Record<HomeAssistantStatus["state"], string> = { off: "Off", connecting: "Connecting", connected: "Connected", waiting: "Waiting to try again" };

export function home_assistant_summary(status: HomeAssistantStatus): string {
  if (status.state === "off") return "Not linked to Home Assistant; set it up under Settings → Home Assistant.";
  if (status.state === "connected") return `Linked to Home Assistant through ${status.broker}: ${status.entities} entities under ${status.base_topic}.`;
  return `${bridge_text[status.state]}: ${status.broker}${status.error ? ` (${status.error})` : ""}.`;
}

// ── View ─────────────────────────────────────────────────────────────────────

export function ComputerView() {
  const [watch] = useState(create_watch);
  useEffect(() => {
    const timer = setInterval(() => watch.bump(), refresh_seconds * 1000);
    const stop = data_watch.subscribe(() => watch.bump());
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [watch]);
  const readings = use_resource(() => calls().list_readings(), [], { watch });
  const status = use_data((api) => api.get_home_assistant_status());
  const device = use_data((api) => api.get_this_device());

  return (
    <>
      <PageHeading title="This computer" subtitle={device.data ? `${device.data.name}${status.data ? ` · ${home_assistant_summary(status.data)}` : ""}` : undefined} />
      <Loaded resource={readings}>
        {(entities) => {
          if (entities.length === 0) return <Empty title="Nothing to read" hint="Turn on This computer's plugins, such as Processor and memory, under Settings → Plugins." />;
          const plugin_ids = [...new Set(entities.map((entity) => entity.plugin_id))];
          return (
            <>
              {plugin_ids.map((plugin_id) => (
                <Group key={plugin_id} plugin_id={plugin_id} entities={entities.filter((entity) => entity.plugin_id === plugin_id)} />
              ))}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
