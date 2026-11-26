// The desktop's notifications as programs show them, read by watching the session bus for calls to
// org.freedesktop.Notifications' Notify, as Valent's fdo plugin does; busctl prints each call as a line of JSON.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_program, whole_lines } from "@x-tech-laboratories/x-libs/agent/programs";

import type { DesktopNotice, DesktopNotices } from "./services.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

// The notification one of busctl's JSON lines describes, or null for any other line.
export function read_notify_call(line: string): DesktopNotice | null {
  let message: { member?: unknown; payload?: { data?: unknown } };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return null;
  }
  if (message.member !== "Notify" || !Array.isArray(message.payload?.data)) return null;
  const [app, , , title, body, , hints] = message.payload.data as unknown[];
  const urgency = (hints as Record<string, { data?: unknown }> | undefined)?.urgency?.data;
  return {
    app: typeof app === "string" ? app : "",
    title: typeof title === "string" ? title : "",
    body: typeof body === "string" ? body : "",
    urgency: urgency === 0 ? "low" : urgency === 2 ? "critical" : "normal",
  };
}

// ── Watching ─────────────────────────────────────────────────────────────────

const match = "type=method_call,interface=org.freedesktop.Notifications,member=Notify";

export function linux_notices(log: (message: string) => void = () => {}): DesktopNotices {
  const listeners = new Set<(notice: DesktopNotice) => void>();
  let controller: AbortController | null = null;

  // busctl runs while anyone listens, and starts again after it ends, waiting longer each time up to five minutes.
  async function run(signal: AbortSignal): Promise<void> {
    let delay = 1;
    while (!signal.aborted) {
      const started = Date.now();
      const lines = whole_lines({
        write: (chunk) => {
          for (const line of String(chunk).split("\n")) {
            const notice = read_notify_call(line);
            if (notice) for (const listener of listeners) listener(notice);
          }
        },
      });
      const result = await run_program(["busctl", "--user", "monitor", "--match", match, "--json=short"], { signal, stdout: "show", out: lines, stderr: "keep" }).catch((error: unknown) => ({ exit_code: -1, stderr: String(error), stdout: "" }));
      lines.flush();
      if (signal.aborted) return;
      if (Date.now() - started > 60_000) delay = 1;
      log(`desktop notifications: busctl ended (${result.stderr.trim().split("\n")[0] || `exit code ${result.exit_code}`}); watching again in ${delay} s`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      delay = Math.min(delay * 2, 300);
    }
  }

  return {
    watch(listener) {
      listeners.add(listener);
      if (!controller) {
        controller = new AbortController();
        void run(controller.signal);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          controller?.abort();
          controller = null;
        }
      };
    },
  };
}
