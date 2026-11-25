// The Commands page: the command lines paired devices may run on this computer, added, edited, ordered and removed,
// each sent to every connected device as soon as it changes.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type FormEvent } from "react";
import { confirm_dialog, Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow, PageHeading, RowActions } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { Command } from "../../shared/commands/store.ts";
import { calls, succeeds, use_data } from "../api.ts";

// ── Editing ──────────────────────────────────────────────────────────────────

function CommandDialog({ command, on_close }: { command: Command | null; on_close: () => void }) {
  const [name, set_name] = useState(command?.name ?? "");
  const [line, set_line] = useState(command?.command ?? "");
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (await succeeds(() => calls().save_command({ id: command?.id, name, command: line }), command ? "Command saved." : "Command added.")) on_close();
  };
  return (
    <Dialog title={command ? "Edit command" : "Add a command"} on_close={on_close} form={{ on_submit: (event) => void submit(event), submit_label: command ? "Save" : "Add", submit_disabled: !name.trim() || !line.trim() }}>
      <FormRow label="Name" id="command-name" hint="What devices show, such as Lock screen.">
        <input id="command-name" value={name} onChange={(event) => set_name(event.currentTarget.value)} autoFocus />
      </FormRow>
      <FormRow label="Command" id="command-line" hint="Run by sh as you, such as loginctl lock-session.">
        <input id="command-line" className="monospace" value={line} onChange={(event) => set_line(event.currentTarget.value)} />
      </FormRow>
    </Dialog>
  );
}

function edit(command: Command | null): void {
  open_dialog((close) => <CommandDialog command={command} on_close={close} />);
}

function remove(command: Command): void {
  confirm_dialog({
    title: `Remove ${command.name}?`,
    message: "Devices can no longer run it. History can bring it back.",
    confirm_label: "Remove",
    danger: true,
    run: async () => void (await calls().remove_command(command.id)),
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CommandsView() {
  const commands = use_data((api) => api.list_commands());
  return (
    <>
      <PageHeading
        title="Commands"
        subtitle="Command lines your paired devices can run on this computer, such as locking the screen."
        actions={
          <button type="button" className="accent" onClick={() => edit(null)}>
            Add a command
          </button>
        }
      />
      <Loaded resource={commands}>
        {(list) =>
          list.length === 0 ? (
            <Empty title="No commands yet" hint="Add one, and every paired device lists it under Run commands." />
          ) : (
            <ul className="command-list">
              {list.map((command, index) => (
                <li key={command.id} className="command-row">
                  <button type="button" className="link command-name" onClick={() => edit(command)}>
                    {command.name}
                  </button>
                  <code className="command-line">{command.command}</code>
                  <RowActions index={index} count={list.length} on_move={(from, to) => void succeeds(() => calls().move_command(list[from]!.id, Math.sign(to - from)))} on_remove={() => remove(command)} remove_label={`Remove ${command.name}`} />
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </>
  );
}
