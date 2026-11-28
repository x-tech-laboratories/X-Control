# Instructions for AI agents

X-Control reaches phones and computers over the KDE Connect protocol and controls them. It is a daemon (the server
in `src/server`, or the desktop app's daemon in `src/daemon`) with a React page that runs in a browser, in Electron and
on Android in Capacitor. Read `README.md` first, then `docs/architecture.md`. It follows the
[X-Tech Application Standard](https://x-tech-laboratories.github.io/standards/application/).

## Setup and checks

- `nix-shell` (or `nix develop`) gives Node 24 and an Electron that runs on NixOS; then `npm install`.
- `npm run typecheck`, `npm test` and `npm run lint` must pass before you propose a change.
- While working, run only the tests for what you changed (`npx vitest run tests/<file>`); CI runs the full suite.
- Keep `npm run dev:server`, `npm run dev:web` and `npm run dev:phone` running while you work, so the page shows sample data.
- To look at the desktop app, run it under its own Xvfb display with `--mute-audio`, never on the user's screen.

## Rules

- Never run X-Control on KDE Connect's usual ports (1716 to 1764) on the user's computer: their own KDE Connect or
  Valent and their phone are there. Tests and the dev config use ports above 40000 and turn discovery off, which
  keeps Bluetooth off too: never register X-Control's Bluetooth profile with the user's BlueZ. Tests use a pretend BlueZ.
- Each Valent or KDE Connect feature is a plugin in `src/server/plugins/` with its manifest in
  `src/shared/plugins/manifests.ts`, its state in `src/shared/plugins/states.ts` and its panel in `src/web/devices/panels.tsx`.
- Each LNXlink feature is a plugin providing `entities`, readings and controls of this computer that show under This
  computer and go to Home Assistant over MQTT; its reads go through `SystemServices.readings`, `power` or `units`.
- The System Bridge server in `src/server/system_bridge/` must stay as Home Assistant's integration reads it: frames
  with only `id`, `type`, `subtype`, `data`, `message` and `module`, and no module answered with null. See `docs/architecture.md`.
- Plugins reach the computer only through `SystemServices`; the Linux side runs programs through X-App, and only the run commands the user wrote go through a shell.
- Code in `src/shared/` runs in the daemon and in the page: no DOM, no `node:` imports.
- A call that only reads is named `list_`, `get_`, `search_`, `lookup_` or `export_`; any other name announces a change.
- Every call has a spec saying what it does and its arguments, so the API and MCP offer it too.
- A released migration step is never edited; change `schema.ts` and run `npm run db:generate`.
- Use X-App widgets and Halon classes; `app.css` holds layout only and never a colour. A widget two apps could use goes into X-App.
- Tests use a throwaway database and temp folders, never `dev-data/` or a real profile.
- Comments are one plain line saying what the code does now; names are snake_case, components PascalCase.
- Commit messages follow Conventional Commits and end with an `Assisted-by:` trailer naming the tool.
