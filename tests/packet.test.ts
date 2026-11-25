import { describe, expect, test } from "vitest";

import { clean_device_name, create_line_reader, is_device_id, make_packet, new_device_id, parse_packet, read_identity, serialize_packet } from "../src/shared/kdeconnect/packet.ts";

describe("packets", () => {
  test("go out as one JSON line and come back the same", () => {
    const packet = make_packet("kdeconnect.ping", { message: "hi" });
    const line = serialize_packet(packet);
    expect(line.endsWith("\n")).toBe(true);
    expect(parse_packet(line.trim())).toEqual(packet);
  });

  test("keep a payload's size and port", () => {
    const parsed = parse_packet(JSON.stringify({ id: 1, type: "kdeconnect.share.request", body: {}, payloadSize: 10, payloadTransferInfo: { port: 1739 } }));
    expect(parsed?.payloadSize).toBe(10);
    expect(parsed?.payloadTransferInfo?.port).toBe(1739);
  });

  test("refuse lines that are not packets", () => {
    expect(parse_packet("not json")).toBeNull();
    expect(parse_packet("[1]")).toBeNull();
    expect(parse_packet(JSON.stringify({ type: "other.thing", body: {} }))).toBeNull();
    expect(parse_packet(JSON.stringify({ type: "kdeconnect.ping", body: [] }))).toBeNull();
  });

  test("are split into lines however the text arrives", () => {
    const lines: string[] = [];
    const reader = create_line_reader((line) => lines.push(line));
    reader.push('{"a":1}\n{"b"');
    reader.push(':2}\n\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.pending()).toBe(4);
  });
});

describe("identities", () => {
  const identity = (body: Record<string, unknown>) => read_identity(make_packet("kdeconnect.identity", { deviceId: "a".repeat(32), deviceName: "Phone", deviceType: "phone", protocolVersion: 8, incomingCapabilities: ["kdeconnect.ping"], outgoingCapabilities: [], ...body }));

  test("are read from protocol version 8 on", () => {
    expect(identity({})?.deviceName).toBe("Phone");
    expect(identity({ protocolVersion: 7 })).toBeNull();
  });

  test("need a device id KDE Connect accepts", () => {
    expect(identity({ deviceId: "short" })).toBeNull();
    expect(is_device_id(new_device_id())).toBe(true);
    expect(is_device_id("_a5a2e8a3_d9f8_4f6b_9c5e_2b1d7e1c3f4a_")).toBe(true);
  });

  test("fall back for an unknown type and leave out bad capability lists", () => {
    const read = identity({ deviceType: "toaster", incomingCapabilities: "nope" });
    expect(read?.deviceType).toBe("desktop");
    expect(read?.incomingCapabilities).toEqual([]);
  });

  test("clean names of the characters the protocol forbids", () => {
    expect(clean_device_name('Pat\'s "phone"!')).toBe("Pats phone");
    expect(clean_device_name("...")).toBe("X-Control");
    expect(clean_device_name("x".repeat(40))).toHaveLength(32);
  });
});
