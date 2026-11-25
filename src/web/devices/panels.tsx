// What each bundled plugin shows on a device's page: its battery, signal, notifications, media players and the
// rest, each drawn from what the plugin knows of the device and acting through the device's actions.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type ComponentType, type FormEvent } from "react";
import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Icon, MuteIcon, NextIcon, PauseIcon, PlayIcon, PreviousIcon, VolumeHighIcon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { Facts, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { ProgressBar } from "@x-tech-laboratories/x-libs/web/react/progress";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";

import { name_for } from "../../shared/plugins/contacts.ts";
import type { BatteryState, CallState, ContactsState, InputState, LockState, MediaState, NotificationState, RemoteCommandState, SftpState, ShareState, SignalState, SmsState, VolumeState } from "../../shared/plugins/states.ts";
import { succeeds } from "../api.ts";
import type { DevicePanelProps } from "../plugins.tsx";

// ── Helpers ──────────────────────────────────────────────────────────────────

function state_of<State>(props: DevicePanelProps, plugin_id: string): State | undefined {
  return props.device.plugins[plugin_id] as State | undefined;
}

// A one-line form: a text field and a button that runs an action with what was typed, then clears it.
function SendField({ label, button, on_send, multiline = false }: { label: string; button: string; on_send: (text: string) => Promise<boolean>; multiline?: boolean }) {
  const [text, set_text] = useState("");
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (text.trim() && (await on_send(text.trim()))) set_text("");
  };
  return (
    <form className="send-field" onSubmit={(event) => void submit(event)}>
      {multiline ? (
        <textarea aria-label={label} placeholder={label} value={text} rows={2} onChange={(event) => set_text(event.currentTarget.value)} />
      ) : (
        <input aria-label={label} placeholder={label} value={text} onChange={(event) => set_text(event.currentTarget.value)} />
      )}
      <button type="submit" disabled={!text.trim()}>
        {button}
      </button>
    </form>
  );
}

const run = (props: DevicePanelProps, action: string, args: Record<string, unknown> = {}, done?: string): Promise<boolean> => succeeds(() => props.run(action, args), done);

// ── Battery and signal ───────────────────────────────────────────────────────

function BatteryPanel(props: DevicePanelProps) {
  const battery = state_of<BatteryState>(props, "battery");
  if (!battery || battery.charge < 0) return null;
  return (
    <Section title="Battery" level={3}>
      <ProgressBar value={battery.charge} max={100} label="Battery" detail={`${battery.charge}%${battery.is_charging ? ", charging" : ""}`} />
    </Section>
  );
}

const signal_words = ["None", "Poor", "Fair", "Good", "Great"];

function SignalPanel(props: DevicePanelProps) {
  const signals = Object.entries(state_of<SignalState>(props, "connectivity_report")?.signals ?? {});
  if (signals.length === 0) return null;
  return (
    <Section title="Mobile network" level={3}>
      <Facts rows={signals.map(([sim, signal]) => [signals.length > 1 ? `SIM ${sim}` : "Signal", `${signal.network ? `${signal.network}, ` : ""}${(signal_words[signal.strength] ?? String(signal.strength)).toLowerCase()}`])} />
    </Section>
  );
}

// ── Calls and lock ───────────────────────────────────────────────────────────

function CallPanel(props: DevicePanelProps) {
  const call = state_of<CallState>(props, "telephony")?.call;
  if (!call) return null;
  return (
    <Section title={call.event === "ringing" ? "Incoming call" : "On a call"} level={3} tools={call.event === "ringing" ? <button type="button" onClick={() => void run(props, "mute")}>Mute ringing</button> : null}>
      <p>{call.caller}</p>
    </Section>
  );
}

function LockPanel(props: DevicePanelProps) {
  const lock = state_of<LockState>(props, "lock");
  if (!lock) return null;
  return (
    <Section title="Screen" level={3} tools={<button type="button" onClick={() => void run(props, lock.is_locked ? "unlock" : "lock")}>{lock.is_locked ? "Unlock" : "Lock"}</button>}>
      <p>
        <Badge tone={lock.is_locked ? "good" : "warn"}>{lock.is_locked ? "Locked" : "Unlocked"}</Badge>
      </p>
    </Section>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────

function NotificationsPanel(props: DevicePanelProps) {
  const state = state_of<NotificationState>(props, "notification");
  const notifications = state?.notifications ?? [];
  if (!state && !props.device.outgoing.includes("kdeconnect.notification")) return null;
  return (
    <Section title="Notifications" level={3}>
      {notifications.length === 0 ? (
        <p className="muted">No notifications.</p>
      ) : (
        <ul className="notification-list">
          {notifications.map((notification) => (
            <li key={notification.id} className="notification">
              <div className="notification-head">
                <strong>{notification.title || notification.app}</strong>
                <span className="muted">
                  {notification.app} · <Age epoch={Math.floor(notification.time / 1000)} />
                </span>
              </div>
              {notification.text && <p>{notification.text}</p>}
              <div className="notification-actions">
                {notification.actions.map((action) => (
                  <button key={action} type="button" onClick={() => void run(props, "act", { id: notification.id, action })}>
                    {action}
                  </button>
                ))}
                {notification.is_clearable && (
                  <button type="button" onClick={() => void run(props, "dismiss", { id: notification.id })}>
                    Dismiss
                  </button>
                )}
              </div>
              {notification.reply_id && <SendField label="Reply" button="Send" on_send={(message) => run(props, "reply", { reply_id: notification.reply_id, message }, "Reply sent.")} />}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Sharing and clipboard ────────────────────────────────────────────────────

function SharePanel(props: DevicePanelProps) {
  const received = state_of<ShareState>(props, "share")?.received ?? [];
  if (!props.device.incoming.includes("kdeconnect.share.request")) return null;
  return (
    <Section title="Share" level={3}>
      <SendField label="A link to open on the device" button="Send link" on_send={(url) => run(props, "url", { url }, "Link sent.")} />
      <SendField label="Text to send" button="Send text" multiline on_send={(text) => run(props, "text", { text }, "Text sent.")} />
      {received.length > 0 && (
        <Facts layout="rows" rows={received.map((shared) => [shared.kind === "file" ? "File" : shared.kind === "url" ? "Link" : "Text", <span className="shared-value">{shared.value}</span>])} />
      )}
    </Section>
  );
}

function ClipboardPanel(props: DevicePanelProps) {
  if (!props.device.incoming.includes("kdeconnect.clipboard")) return null;
  return (
    <Section title="Clipboard" level={3} tools={<button type="button" onClick={() => void run(props, "push", {}, "Clipboard sent.")}>Send this clipboard</button>}>
      <SendField label="Text to put on the device's clipboard" button="Copy to device" on_send={(text) => run(props, "send", { text }, "Copied to the device.")} />
    </Section>
  );
}

// ── Commands ─────────────────────────────────────────────────────────────────

function CommandsPanel(props: DevicePanelProps) {
  const commands = state_of<RemoteCommandState>(props, "runcommand")?.commands ?? [];
  if (commands.length === 0) return null;
  return (
    <Section title="Commands" level={3} tools={<button type="button" onClick={() => void run(props, "refresh")}>Refresh</button>}>
      <div className="button-list">
        {commands.map((command) => (
          <button key={command.key} type="button" title={command.command} onClick={() => void run(props, "run", { key: command.key }, `${command.name} ran.`)}>
            {command.name}
          </button>
        ))}
      </div>
    </Section>
  );
}

// ── Media and volume ─────────────────────────────────────────────────────────

function MediaPanel(props: DevicePanelProps) {
  const players = state_of<MediaState>(props, "mpris")?.players ?? [];
  if (players.length === 0) return null;
  return (
    <Section title="Media" level={3}>
      {players.map((player) => (
        <div key={player.name} className="media-player">
          <div className="media-title">
            <strong>{player.title || player.name}</strong>
            {player.artist && <span className="muted">{player.artist}</span>}
          </div>
          <div className="media-controls" role="group" aria-label={`${player.name} controls`}>
            <button type="button" aria-label="Previous" onClick={() => void run(props, "act", { player: player.name, action: "Previous" })}>
              <Icon icon={PreviousIcon} />
            </button>
            <button type="button" aria-label={player.is_playing ? "Pause" : "Play"} onClick={() => void run(props, "act", { player: player.name, action: "PlayPause" })}>
              <Icon icon={player.is_playing ? PauseIcon : PlayIcon} />
            </button>
            <button type="button" aria-label="Next" onClick={() => void run(props, "act", { player: player.name, action: "Next" })}>
              <Icon icon={NextIcon} />
            </button>
            <input type="range" aria-label={`${player.name} volume`} min={0} max={100} value={player.volume} onChange={(event) => void run(props, "volume", { player: player.name, volume: Number(event.currentTarget.value) })} />
          </div>
        </div>
      ))}
    </Section>
  );
}

function VolumePanel(props: DevicePanelProps) {
  const sinks = state_of<VolumeState>(props, "systemvolume")?.sinks ?? [];
  if (sinks.length === 0) return null;
  return (
    <Section title="Speakers" level={3}>
      {sinks.map((sink) => (
        <div key={sink.name} className="media-player">
          <div className="media-title">
            <strong>{sink.description || sink.name}</strong>
            {sink.enabled && <Badge tone="info">In use</Badge>}
          </div>
          <div className="media-controls">
            <button type="button" aria-label={sink.muted ? "Unmute" : "Mute"} aria-pressed={sink.muted} onClick={() => void run(props, "mute", { sink: sink.name, muted: !sink.muted })}>
              <Icon icon={sink.muted ? MuteIcon : VolumeHighIcon} />
            </button>
            <input type="range" aria-label={`${sink.description || sink.name} volume`} min={0} max={sink.max_volume} value={sink.volume} onChange={(event) => void run(props, "volume", { sink: sink.name, volume: Number(event.currentTarget.value) })} />
          </div>
        </div>
      ))}
    </Section>
  );
}

// ── Messages and contacts ────────────────────────────────────────────────────

function MessagesPanel(props: DevicePanelProps) {
  const [open, set_open] = useState<number | null>(null);
  const conversations = state_of<SmsState>(props, "sms")?.conversations ?? [];
  const contacts = state_of<ContactsState>(props, "contacts")?.contacts ?? [];
  if (conversations.length === 0 && !props.device.incoming.includes("kdeconnect.sms.request")) return null;
  const who = (addresses: string[]): string => addresses.map((address) => name_for(contacts, address)).join(", ") || "Unknown";
  const shown = conversations.find((conversation) => conversation.thread_id === open);
  return (
    <Section title="Messages" level={3} tools={<button type="button" onClick={() => void run(props, "refresh")}>Refresh</button>}>
      {shown ? (
        <>
          <div className="button-list">
            <button type="button" onClick={() => set_open(null)}>All conversations</button>
            <button type="button" onClick={() => void run(props, "open", { thread_id: shown.thread_id })}>Load older</button>
          </div>
          <h4>{who(shown.addresses)}</h4>
          <ul className="message-list">
            {[...shown.messages].reverse().map((message) => (
              <li key={message.id} className={message.is_sent ? "message sent" : "message"}>
                <span className="muted small">
                  {message.is_sent ? "You" : who(message.addresses)} · <Age epoch={Math.floor(message.date / 1000)} />
                </span>
                <p>{message.body}</p>
              </li>
            ))}
          </ul>
          <SendField label="Message" button="Send" multiline on_send={(message) => run(props, "send", { addresses: shown.addresses, message }, "Message sent.")} />
        </>
      ) : conversations.length === 0 ? (
        <p className="muted">No messages yet.</p>
      ) : (
        <ul className="notification-list">
          {conversations.map((conversation) => (
            <li key={conversation.thread_id}>
              <button type="button" className="link" onClick={() => (set_open(conversation.thread_id), void run(props, "open", { thread_id: conversation.thread_id }))}>
                {who(conversation.addresses)}
              </button>{" "}
              <span className="muted">{conversation.messages[0]?.body}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ContactsPanel(props: DevicePanelProps) {
  const contacts = state_of<ContactsState>(props, "contacts")?.contacts;
  if (!contacts) return null;
  return (
    <Section title="Contacts" level={3} tools={<button type="button" onClick={() => void run(props, "refresh")}>Refresh</button>}>
      <p>{contacts.length === 1 ? "1 contact" : `${contacts.length} contacts`}, used to name messages and calls.</p>
    </Section>
  );
}

// ── Files and input ──────────────────────────────────────────────────────────

function FilesPanel(props: DevicePanelProps) {
  const sftp = state_of<SftpState>(props, "sftp");
  if (!sftp && !props.device.incoming.includes("kdeconnect.sftp.request")) return null;
  return (
    <Section
      title="Files"
      level={3}
      tools={sftp?.folder ? <button type="button" onClick={() => void run(props, "unmount")}>Stop browsing</button> : <button type="button" onClick={() => void run(props, "browse", {}, "Opening the phone's files.")}>Browse files</button>}
    >
      {sftp?.error && <p className="muted">{sftp.error}</p>}
      {sftp?.folder ? <Facts layout="rows" rows={sftp.places.length ? sftp.places.map((place) => [place.name, <code className="shared-value">{place.path}</code>]) : [["Mounted at", <code className="shared-value">{sftp.folder}</code>]]} /> : <p className="muted">The phone's storage opens in this computer's file manager.</p>}
    </Section>
  );
}

const typing_keys = ["Return", "BackSpace", "Tab", "Escape", "Left", "Up", "Right", "Down"];

function InputPanel(props: DevicePanelProps) {
  const ready = state_of<InputState>(props, "mousepad")?.keyboard_ready;
  if (!ready) return null;
  return (
    <Section title="Keyboard" level={3}>
      <SendField label="Text to type on the device" button="Type" on_send={(text) => run(props, "type", { text })} />
      <div className="button-list">
        {typing_keys.map((key) => (
          <button key={key} type="button" onClick={() => void run(props, "key", { key })}>
            {key === "BackSpace" ? "Backspace" : key === "Return" ? "Enter" : key}
          </button>
        ))}
      </div>
    </Section>
  );
}

// ── Panels ───────────────────────────────────────────────────────────────────

// Each plugin's panel by plugin id; a plugin with nothing to show here has none.
export const panels: Record<string, ComponentType<DevicePanelProps>> = {
  battery: BatteryPanel,
  connectivity_report: SignalPanel,
  telephony: CallPanel,
  lock: LockPanel,
  notification: NotificationsPanel,
  share: SharePanel,
  clipboard: ClipboardPanel,
  runcommand: CommandsPanel,
  mpris: MediaPanel,
  systemvolume: VolumePanel,
  sms: MessagesPanel,
  contacts: ContactsPanel,
  sftp: FilesPanel,
  mousepad: InputPanel,
};
