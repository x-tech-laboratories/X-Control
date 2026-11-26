// Messages: a phone's text conversations, their newest message fetched when it connects and the rest of a
// conversation when it is opened, and new messages sent through the phone.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { sms_manifest } from "../../shared/plugins/manifests.ts";
import type { Conversation, SmsState, TextMessage } from "../../shared/plugins/states.ts";
import type { ControlPluginApi } from "./api.ts";
import { text_arg } from "./helpers.ts";

// ── Packets ────────────────────────────────────────────────────────────────

const messages_type = "kdeconnect.sms.messages";
const ask_conversations_type = "kdeconnect.sms.request_conversations";
const ask_conversation_type = "kdeconnect.sms.request_conversation";
const send_type = "kdeconnect.sms.request";

// How many messages each conversation keeps, newest first.
const most_kept = 200;
// How many older messages opening a conversation asks for.
const page_size = 50;
// Android's type for a message the phone sent.
const sent_type = 2;

// A message as the phone describes it, or null for one that is not a text message.
export function read_message(raw: unknown): TextMessage | null {
  const message = (raw ?? {}) as Record<string, unknown>;
  const id = Number(message._id);
  const thread_id = Number(message.thread_id);
  if (!Number.isFinite(id) || !Number.isFinite(thread_id)) return null;
  const addresses = Array.isArray(message.addresses)
    ? message.addresses.flatMap((entry) => {
        const address = (entry as { address?: unknown })?.address;
        return typeof address === "string" ? [address] : [];
      })
    : [];
  return {
    id,
    thread_id,
    addresses,
    body: typeof message.body === "string" ? message.body : "",
    date: Number(message.date) || 0,
    is_sent: Number(message.type) === sent_type,
    is_read: Number(message.read) === 1 || message.read === true,
  };
}

// The conversations with new messages laid in, each newest first and cut to its limit, the newest conversation first.
export function merge_messages(conversations: Conversation[], messages: TextMessage[]): Conversation[] {
  const by_thread = new Map(conversations.map((conversation) => [conversation.thread_id, { ...conversation, messages: [...conversation.messages] }]));
  for (const message of messages) {
    const conversation = by_thread.get(message.thread_id) ?? { thread_id: message.thread_id, addresses: message.addresses, messages: [] };
    conversation.messages = [message, ...conversation.messages.filter((kept) => kept.id !== message.id)];
    if (message.addresses.length) conversation.addresses = message.addresses;
    by_thread.set(message.thread_id, conversation);
  }
  return [...by_thread.values()]
    .map((conversation) => ({ ...conversation, messages: conversation.messages.sort((first, second) => second.date - first.date).slice(0, most_kept) }))
    .sort((first, second) => (second.messages[0]?.date ?? 0) - (first.messages[0]?.date ?? 0));
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const sms_plugin = define_plugin<ControlPluginApi>({
  ...sms_manifest,
  start(context) {
    context.provide("capability", "sms", {
      keep_state: true,
      incoming: [messages_type],
      outgoing: [ask_conversations_type, ask_conversation_type, send_type],
      connected: (device) => (device.takes(ask_conversations_type) ? device.send(ask_conversations_type, {}) : undefined),
      packet(device, packet) {
        const messages = (Array.isArray(packet.body.messages) ? packet.body.messages : []).map(read_message).filter((message): message is TextMessage => message !== null);
        if (messages.length === 0) return;
        device.set_state({ conversations: merge_messages(device.state<SmsState>()?.conversations ?? [], messages) } satisfies SmsState);
      },
      actions: {
        open: {
          label: "Load a conversation",
          description: "Asks the phone for the older messages of one conversation.",
          params: [{ name: "thread_id", schema: { type: "integer", description: "The conversation's thread_id." } }],
          needs: ask_conversation_type,
          run: (device, args) => {
            const thread = Number(args.thread_id);
            const oldest = device.state<SmsState>()?.conversations.find((conversation) => conversation.thread_id === thread)?.messages.at(-1)?.date;
            return device.send(ask_conversation_type, { threadID: thread, ...(oldest ? { rangeStartTimestamp: oldest } : {}), numberToRequest: page_size });
          },
        },
        send: {
          label: "Send a message",
          description: "Sends a text message through the phone to one or more numbers.",
          params: [
            { name: "addresses", schema: { type: "array", items: { type: "string" }, description: "The numbers to send to, such as those of a conversation." } },
            { name: "message", schema: { type: "string", description: "The message." } },
          ],
          needs: send_type,
          run: (device, args) => {
            const addresses = Array.isArray(args.addresses) ? args.addresses.filter((address): address is string => typeof address === "string" && address.trim() !== "") : [];
            if (addresses.length === 0) throw new Error("addresses is needed.");
            return device.send(send_type, { version: 2, addresses: addresses.map((address) => ({ address })), messageBody: text_arg(args, "message") });
          },
        },
        refresh: { label: "Refresh messages", description: "Asks the phone for its conversations again.", needs: ask_conversations_type, run: (device) => device.send(ask_conversations_type, {}) },
      },
    });
  },
});
