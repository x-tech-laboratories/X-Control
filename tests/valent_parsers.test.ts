import { describe, expect, test } from "vitest";

import { addresses_to_tell } from "../src/server/kdeconnect/mdns.ts";
import { name_for, read_vcard } from "../src/server/plugins/contacts.ts";
import { modifiers_of, number_of_special_key, special_key_of } from "../src/server/plugins/mousepad.ts";
import { read_places, read_share } from "../src/server/plugins/sftp.ts";
import { merge_messages, read_message } from "../src/server/plugins/sms.ts";
import { ydotool_key_presses } from "../src/server/system/linux.ts";

describe("contacts", () => {
  test("are read from a vCard, folded lines joined", () => {
    const card = "BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Alex\r\n  Smith\r\nTEL;CELL:+44 7946 000000\r\nitem1.TEL:01632 960000\r\nEND:VCARD";
    expect(read_vcard("u1", card)).toEqual({ uid: "u1", name: "Alex Smith", phones: ["+44 7946 000000", "01632 960000"] });
  });

  test("give a number its name however it is written", () => {
    const contacts = [{ uid: "u1", name: "Alex", phones: ["+44 7946 000000"] }];
    expect(name_for(contacts, "07946000000")).toBe("Alex");
    expect(name_for(contacts, "555")).toBe("555");
  });
});

describe("text messages", () => {
  test("are read from Android's fields", () => {
    expect(read_message({ _id: 5, thread_id: 2, addresses: [{ address: "123" }], body: "Hi", date: 1000, type: 2, read: 1 })).toEqual({ id: 5, thread_id: 2, addresses: ["123"], body: "Hi", date: 1000, is_sent: true, is_read: true });
    expect(read_message({ body: "no ids" })).toBeNull();
  });

  test("are merged into conversations, newest first, without repeats", () => {
    const first = read_message({ _id: 1, thread_id: 7, addresses: [{ address: "1" }], body: "old", date: 10, type: 1 })!;
    const second = read_message({ _id: 2, thread_id: 7, addresses: [{ address: "1" }], body: "new", date: 20, type: 1 })!;
    const other = read_message({ _id: 3, thread_id: 8, addresses: [{ address: "2" }], body: "older thread", date: 5, type: 1 })!;
    const merged = merge_messages(merge_messages([], [first, other]), [second, first]);
    expect(merged.map((conversation) => conversation.thread_id)).toEqual([7, 8]);
    expect(merged[0]!.messages.map((message) => message.body)).toEqual(["new", "old"]);
  });
});

describe("browsing files", () => {
  test("needs a port, user and password to mount", () => {
    expect(read_share({ ip: "10.0.0.2", port: 1739, user: "kdeconnect", password: "once", path: "/storage" }, "x")).toEqual({ host: "10.0.0.2", port: 1739, user: "kdeconnect", password: "once", path: "/storage" });
    expect(read_share({ port: 1739, user: "kdeconnect", password: "once" }, "10.0.0.9")?.host).toBe("10.0.0.9");
    expect(read_share({ port: 1739 }, "x")).toBeNull();
  });

  test("lists the phone's storage places under the mount", () => {
    const places = read_places({ multiPaths: ["/storage/emulated/0", "/storage/sd"], pathNames: ["All files", "SD card"] }, "/storage", "/mnt/phone");
    expect(places).toEqual([
      { name: "All files", path: "/mnt/phone/emulated/0" },
      { name: "SD card", path: "/mnt/phone/sd" },
    ]);
  });
});

describe("remote input", () => {
  test("maps KDE Connect's numbered keys both ways", () => {
    expect(special_key_of(1)).toBe("BackSpace");
    expect(special_key_of(12)).toBe("Return");
    expect(special_key_of(21)).toBe("F1");
    expect(special_key_of(18)).toBeNull();
    expect(number_of_special_key("F12")).toBe(32);
  });

  test("reads the modifiers held", () => {
    expect(modifiers_of({ ctrl: true, shift: true, alt: false })).toEqual(["ctrl", "shift"]);
  });

  test("presses and lets go of ydotool's keys in order", () => {
    expect(ydotool_key_presses("Return", ["ctrl"])).toEqual(["29:1", "28:1", "28:0", "29:0"]);
    expect(ydotool_key_presses("é", [])).toBeNull();
  });
});

describe("mDNS", () => {
  test("tells other KDE Connect devices, never this one", () => {
    expect(addresses_to_tell({ name: "b".repeat(32), txt: { id: "b".repeat(32) }, addresses: ["10.0.0.2", "fe80::1"] }, "a".repeat(32))).toEqual(["10.0.0.2"]);
    expect(addresses_to_tell({ name: "a".repeat(32), txt: { id: "a".repeat(32) }, addresses: ["10.0.0.3"] }, "a".repeat(32))).toEqual([]);
    expect(addresses_to_tell({ name: "x", txt: {}, addresses: [], referer: { address: "10.0.0.4", family: "IPv4", port: 5353, size: 1 } }, "a".repeat(32))).toEqual(["10.0.0.4"]);
  });
});
