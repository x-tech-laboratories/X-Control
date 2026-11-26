import { describe, expect, test } from "vitest";

import { create_call_quiet, lowered_share } from "../src/server/plugins/call_quiet.ts";
import { desktop_notification_body, should_forward } from "../src/server/plugins/notification.ts";
import { read_notify_call } from "../src/server/system/linux_notices.ts";
import { sample_computer } from "../src/server/system/sample.ts";

describe("desktop notifications", () => {
  test("reads busctl's line for a Notify call", () => {
    const line = '{"type":"method_call","member":"Notify","payload":{"type":"sissssa{sv}i","data":["firefox",0,"firefox","Test title","Test body",[],{"urgency":{"type":"y","data":2}},5000]}}';
    expect(read_notify_call(line)).toEqual({ app: "firefox", title: "Test title", body: "Test body", urgency: "critical" });
    expect(read_notify_call('{"member":"CloseNotification","payload":{"data":[3]}}')).toBeNull();
    expect(read_notify_call("not json")).toBeNull();
  });

  test("forwards what other programs show, as a KDE Connect notification", () => {
    const notice = { app: "Thunderbird", title: "New mail", body: "Hello", urgency: "low" as const };
    expect(should_forward(notice, [])).toBe(true);
    expect(should_forward(notice, ["thunderbird"])).toBe(false);
    expect(should_forward({ ...notice, app: "X-Control" }, [])).toBe(false);
    expect(should_forward({ ...notice, title: "", body: "" }, [])).toBe(false);
    expect(desktop_notification_body(notice, "x1", 1000)).toEqual({ id: "x1", appName: "Thunderbird", title: "New mail", text: "Hello", ticker: "New mail: Hello", isClearable: true, time: "1000", silent: true });
  });
});

describe("calls", () => {
  test("turns down, mutes and pauses, then puts back only what the user left alone", async () => {
    const computer = sample_computer();
    const speakers = () => computer.state.sinks.find((sink) => sink.is_default)!;
    const quiet = create_call_quiet(computer);
    await quiet.apply({ speakers: "lower", pause: false });
    expect(speakers().volume).toBe(Math.round(65_536 * lowered_share));
    await quiet.apply({ speakers: "mute", pause: true });
    expect(speakers().muted).toBe(true);
    expect(computer.state.players.every((player) => !player.is_playing)).toBe(true);
    // The user turned the volume up during the call, so it stays where they put it.
    speakers().volume = 50_000;
    await quiet.restore();
    expect(speakers()).toMatchObject({ volume: 50_000, muted: false });
    expect(computer.state.players.find((player) => player.name === "music")?.is_playing).toBe(true);
    expect(computer.state.players.find((player) => player.name === "video")?.is_playing).toBe(false);
  });

  test("leaves the speakers alone when told to, and does nothing to put back", async () => {
    const computer = sample_computer();
    const quiet = create_call_quiet(computer);
    await quiet.apply({ speakers: "nothing", pause: false });
    await quiet.restore();
    expect(computer.state.sinks.find((sink) => sink.is_default)).toMatchObject({ volume: 40_000, muted: false });
  });
});
