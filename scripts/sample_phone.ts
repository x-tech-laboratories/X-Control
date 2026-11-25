// A pretend phone for the dev server's sample data: a second X-Control on this computer that connects to the dev
// server, asks to pair, and once paired sends what a real phone would, such as notifications and its signal.
// Run with `npm run dev:phone` while `npm run dev:server` runs; accept its request in the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { bind_store_methods, open_store } from "../src/shared/store.ts";
import { start_control } from "../src/server/control.ts";
import { sample_computer } from "../src/server/system/sample.ts";

// ── Phone ────────────────────────────────────────────────────────────────────

// The dev server's ports, as config.example.json sets them.
const server_ports = { lowest: 41716, highest: 41730 };
// Kept beside the dev server's data, so the phone stays the same device and stays paired.
const folder = "dev-data/sample-phone";
mkdirSync(folder, { recursive: true });
const database = new DatabaseSync(":memory:");
open_store(database);
bind_store_methods(() => database, () => {}).save_command({ name: "Take a photo", command: "echo photo" });

const control = await start_control({
  database: () => database,
  identity_file: join(folder, "identity.json"),
  downloads_folder: join(folder, "Downloads"),
  mounts_folder: join(folder, "mounts"),
  system: sample_computer(),
  notify: (notice) => console.info(`phone shows: ${notice.title} — ${notice.body}`),
  withdraw: () => {},
  on_change: () => {},
  network: { discovery: false, allow_loopback: true, tcp_ports: { lowest: 41761, highest: 41764 }, payload_ports: { lowest: 41765, highest: 41790 } },
  defaults: { name: "Sample phone", type: "phone" },
  log: (message) => console.info(message),
});

// ── Connecting ───────────────────────────────────────────────────────────────

async function connect(): Promise<string> {
  for (let port = server_ports.lowest; port <= server_ports.highest; port++) {
    try {
      await control.network.connect("127.0.0.1", port);
      for (let tries = 0; tries < 50; tries++) {
        const server = control.devices.list().find((device) => device.is_connected);
        if (server) return server.id;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch {
      // Nothing listens on that port; the next one is tried.
    }
  }
  throw new Error("no dev server found; start it with npm run dev:server");
}

let server_id = await connect();
// The dev server restarts as its code changes, so the phone connects again whenever it is gone.
setInterval(() => {
  if (control.devices.is_connected(server_id)) {
    // An unanswered request lapses after 30 seconds, so the phone asks again until the page accepts.
    if (control.devices.get(server_id).pair_state === "unpaired") void control.methods.pair_device(server_id).catch(() => undefined);
    return;
  }
  connect().then((id) => (server_id = id), () => undefined);
}, 3000);
console.info(`connected to ${control.devices.get(server_id).name}`);
if (control.devices.get(server_id).pair_state !== "paired") {
  await control.methods.pair_device(server_id);
  console.info("asked to pair; accept the request in the page within 30 seconds");
}

// ── Sample packets ───────────────────────────────────────────────────────────

const sample_notifications = [
  { id: "chat-1", appName: "Messages", title: "Alex", text: "Are we still on for tonight?", requestReplyId: "reply-chat-1", actions: ["Mark as read"] },
  { id: "mail-1", appName: "Mail", title: "Your parcel is on its way", text: "It should arrive on Friday." },
  { id: "calendar-1", appName: "Calendar", title: "Dentist", text: "Tomorrow at 9:30" },
];

let sent = false;
setInterval(async () => {
  const server = control.devices.get(server_id);
  if (server.pair_state !== "paired" || !server.is_connected) return void (sent = false);
  if (sent) return;
  sent = true;
  const device = control.devices.handle(server_id, "sample");
  for (const notification of sample_notifications) await device.send("kdeconnect.notification", { ...notification, time: String(Date.now()), isClearable: true, silent: false });
  await device.send("kdeconnect.contacts.response_uids_timestamps", { uids: ["alex", "sam"], alex: 1, sam: 1 });
  await device.send("kdeconnect.contacts.response_vcards", { uids: ["alex", "sam"], alex: "BEGIN:VCARD\nFN:Alex\nTEL:+15550100\nEND:VCARD", sam: "BEGIN:VCARD\nFN:Sam\nTEL:+15550101\nEND:VCARD" });
  const minute = 60_000;
  const now = Date.now();
  const message = (id: number, thread: number, address: string, body: string, ago: number, sent = false) => ({ _id: id, thread_id: thread, addresses: [{ address }], body, date: now - ago * minute, type: sent ? 2 : 1, read: 1 });
  await device.send("kdeconnect.sms.messages", {
    version: 2,
    messages: [
      message(1, 1, "+15550100", "Are we still on for tonight?", 5),
      message(2, 1, "+15550100", "Yes, seven o'clock.", 4, true),
      message(3, 1, "+15550100", "Great, see you there.", 2),
      message(4, 2, "+15550101", "Can you send me the photos?", 90),
    ],
  });
  await device.send("kdeconnect.connectivity_report", { signalStrengths: { "1": { networkType: "5G", signalStrength: 3 } } });
  console.info("paired; sent sample notifications and signal");
}, 1000);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void control.stop().then(() => process.exit(0)));
