// The page's calls, as the web server and the desktop daemon both answer them: the stored data on the database and the
// devices through the control core, taking the arguments in order or by name and telling the other pages of a change.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { FastifyInstance } from "fastify";
import { positional_args } from "@x-tech-laboratories/x-libs/api_spec";
import type { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { send_text } from "@x-tech-laboratories/x-libs/server/replies";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { control_api, control_bridge } from "../shared/bridge.ts";
import { is_read_only, type ControlMethods } from "../shared/page_api.ts";
import { bind_store_methods } from "../shared/store.ts";
import type { Control } from "./control.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

// An import file arrives as one call's argument.
const import_body_limit = 8 * 1024 * 1024;

// Every call bound to the database and the devices; a write tells the control core, then on_change the pages.
export function bind_methods(database: () => SqlDatabase, control: Control, on_change: () => void): ControlMethods {
  const store = bind_store_methods(database, (method) => {
    void control.after_store_change(method).catch((error: unknown) => console.warn(`after ${method}:`, error));
    on_change();
  });
  const devices = Object.fromEntries(
    Object.entries(control.methods).map(([name, method]) => [
      name,
      async (...args: unknown[]) => {
        const result = await (method as (...args: unknown[]) => Promise<unknown>)(...args);
        if (!is_read_only(name)) on_change();
        return result;
      },
    ]),
  );
  return { ...store, ...devices } as ControlMethods;
}

// Runs one call by name, as the page, the API and MCP all make them.
export function dispatch(methods: ControlMethods, method: string, args: unknown[]): Promise<unknown> {
  return control_bridge.dispatch(methods, method, args);
}

// Calls arrive as POST <prefix>/call/<method> with the arguments as a JSON list, or by name as a JSON object.
export function register_control_calls(api: FastifyInstance, database: () => SqlDatabase, control: Control, changes: EventStream): void {
  api.post<{ Params: { method: string } }>("/call/:method", { bodyLimit: import_body_limit }, async (request, reply) => {
    const body: unknown = request.body ?? [];
    const spec = control_api[request.params.method as keyof ControlMethods];
    let args: unknown[];
    if (Array.isArray(body)) args = body;
    else if (spec && typeof body === "object" && body !== null) {
      try {
        args = positional_args(spec, body as Record<string, unknown>);
      } catch (error) {
        return send_text(reply, 400, (error as Error).message);
      }
    } else return send_text(reply, 400, "send the arguments as a JSON list or object");
    const methods = bind_methods(database, control, () => changes.announce_change(changes.client_id_of(request)));
    const result = await dispatch(methods, request.params.method, args);
    if (result === undefined) return reply.code(204).send();
    if (is_read_only(request.params.method)) reply.header("cache-control", "no-store");
    // Fastify would send a string as bare text, which the caller could not tell from JSON.
    return reply.type("application/json").send(JSON.stringify(result));
  });
}
