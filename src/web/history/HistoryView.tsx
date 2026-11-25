// History: the latest changes to every run command, each version restorable and a deleted command brought back.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { VersionKind } from "@x-tech-laboratories/x-libs/history";
import { StateBadge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";

import type { CommandVersion } from "../../shared/history/store.ts";
import { calls, succeeds, use_data } from "../api.ts";

// ── Wording ──────────────────────────────────────────────────────────────────

const change_labels: Record<VersionKind, [text: string, tone: Tone]> = {
  first_seen: ["Already here", "none"],
  created: ["Created", "good"],
  edited: ["Edited", "info"],
  deleted: ["Deleted", "bad"],
  restored: ["Restored", "warn"],
};

function when(changed_at: string): string {
  return new Date(changed_at).toLocaleString();
}

// Brings the version back after a confirm; the command as it is now stays in its history.
function restore(version: CommandVersion): void {
  const name = version.snapshot.name;
  confirm_dialog({
    title: version.kind === "deleted" ? `Bring back ${name}?` : `Restore ${name}?`,
    message: version.kind === "deleted" ? "It comes back as it was when deleted." : `It goes back to how it was on ${when(version.changed_at)}.`,
    confirm_label: version.kind === "deleted" ? "Bring back" : "Restore",
    run: async () => void (await succeeds(() => calls().restore_version(version.id), `${name} is back as it was.`)),
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

const limits: [number, string][] = [
  [50, "Last 50"],
  [200, "Last 200"],
];

export function HistoryView() {
  const [limit, set_limit] = useState(50);
  const versions = use_data((api) => api.list_recent_versions(limit), [limit]);
  const columns: TableColumn<CommandVersion>[] = [
    { label: "When", cell: (version) => when(version.changed_at) },
    { label: "Command", cell: (version) => <>{version.snapshot.name} <code className="muted small">{version.snapshot.command}</code></> },
    { label: "Change", cell: (version) => <StateBadge labels={change_labels} state={version.kind} /> },
    { label: "Made", cell: (version) => (version.origin === "here" ? "Here" : "On another device") },
    {
      label: "Actions",
      id: "actions",
      header: <span className="visually-hidden">Actions</span>,
      class: "actions-cell",
      cell: (version) => (
        <button type="button" onClick={() => restore(version)}>
          {version.kind === "deleted" ? "Bring back" : "Restore"}
        </button>
      ),
    },
  ];
  return (
    <>
      <PageHeading title="History" subtitle="The latest changes to the run commands." />
      <Toolbar>
        <Select label="Changes shown" options={limits} value={limit} on_change={set_limit} />
      </Toolbar>
      <Loaded resource={versions}>
        {(list) => (list.length === 0 ? <Empty title="No changes yet." /> : <DataTable caption="Latest changes" columns={columns} rows={list} row_key={(version) => version.id} />)}
      </Loaded>
    </>
  );
}
