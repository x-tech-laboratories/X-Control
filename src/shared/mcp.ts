// What an AI client reads first about X-Control, wherever the MCP endpoint runs: the server or the desktop daemon.

export const mcp_instructions = [
  "X-Control reaches a person's devices, such as phones and computers, over KDE Connect, and lets them be controlled from here.",
  "list_devices is the place to start; a device must be paired before anything can be done to it, and list_device_actions says what each one offers.",
  "run_device_action runs an action, such as ringing a phone (findmyphone.ring) or sending it a link (share.url).",
  "The run commands under list_commands are what paired devices may run on this computer.",
].join(" ");
