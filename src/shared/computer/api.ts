// The calls on the computer the daemon runs on: its readings and controls, as plugins offer them, and the link that
// publishes them to Home Assistant.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { text } from "../api_schemas.ts";
import type { EntityView, HomeAssistantStatus } from "./model.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export interface ComputerMethods {
  list_readings(): Promise<EntityView[]>;
  set_control(id: string, value: string | number | boolean | null): Promise<EntityView>;
  get_home_assistant_status(): Promise<HomeAssistantStatus>;
}

export const computer_method_names = ["list_readings", "set_control", "get_home_assistant_status"] as const satisfies readonly (keyof ComputerMethods)[];

export const computer_api: ApiSpec<ComputerMethods> = {
  list_readings: {
    description:
      "Every reading and control of the computer the daemon runs on, read now: processor, memory, disks, network, temperatures, power, the session and the desktop's controls, as the plugins turned on offer them. Each has its id (plugin.entity), kind (sensor, binary_sensor, switch, button, number, select or text), value, unit and when it was read.",
    params: [],
  },
  set_control: {
    description:
      "Works one control by id, as list_readings gives it: a switch takes true or false, a number a number in its range, a select one of its options, a text its text and a button null. Answers the control read again. Buttons such as power.shutdown act at once.",
    params: [
      { name: "id", schema: text("The control's id, such as power.suspend or desktop_controls.open.") },
      { name: "value", schema: { description: "The new value; null for a button." } },
    ],
    destructive: true,
  },
  get_home_assistant_status: {
    description: "Whether this computer is linked to Home Assistant over MQTT: off, connecting, connected or waiting to try again, with the broker, the base topic, the entities published and the last error.",
    params: [],
  },
};
