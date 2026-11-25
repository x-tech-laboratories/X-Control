// The argument shapes many calls share, as JSON Schema, for the specs other programs read through MCP and OpenAPI.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";

// ── Shapes ───────────────────────────────────────────────────────────────────

export function text(description: string): JsonSchema {
  return { type: "string", description };
}

export function number(description: string): JsonSchema {
  return { type: "number", description };
}

export function id_of(thing: string): JsonSchema {
  return { type: "string", description: `The ${thing}'s id, as a list or get call gives it.` };
}

export const moment: JsonSchema = { type: "string", description: "A moment as an ISO 8601 timestamp, such as 2026-11-10T18:30:00.000Z." };

export const json_file: JsonSchema = { type: "string", description: "The whole file's text." };
