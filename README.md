# X-Control

Remote access and control for your devices. X-Control reaches phones, tablets and computers over the KDE Connect
protocol, so it pairs with the KDE Connect app on Android, with KDE Connect, Valent and GSConnect on Linux desktops,
and with other X-Control daemons. From its page you see a phone's battery, signal and notifications, answer messages,
ring it, send it links, text and files, share the clipboard, run commands on either side, and control media players
and speakers both ways. It also reads the computer it runs on (processor, memory, disks, network, temperatures,
power and the session) and offers its controls, under This computer and in Home Assistant over MQTT, as LNXlink does,
and through a System Bridge server that Home Assistant's System Bridge integration connects to.

It follows the [X-Tech Application Standard](https://x-tech-laboratories.github.io/standards/application/): one
daemon holds all the work, and the web page, the desktop app and the Android app are UIs onto it.

## What it does

Every feature is a bundled plugin on the X-Libs plugin host, and each can be turned off under Settings → Plugins.

| Plugin | This computer, for a device | A device, from here |
| --- | --- | --- |
| Ping | shows a device's ping | pings it |
| Battery | sends its charge as it changes | shows the charge, warns when low |
| Clipboard | takes what a device copies | sends what you copy here |
| Notifications | — | lists its notifications, dismisses them, replies, presses their buttons |
| Find my device | rings when a device asks | rings it |
| Share | saves files to Downloads, opens links, copies text | sends links, text and files |
| Run commands | runs the commands listed under Commands | runs the device's own commands |
| Mobile network | — | shows its network and signal |
| Calls | — | tells you of incoming and missed calls, mutes the ringing |
| Lock | locks and unlocks the session | locks it |
| Media players | lets a device control the players here | controls its players |
| System volume | lets a device control the speakers here | controls its speakers |
| Contacts | — | reads its contacts, to name messages and calls |
| Messages | — | reads its text conversations and sends messages through it |
| Browse files | — | mounts its storage over SFTP and opens it in the file manager |
| Remote input | a device is its touchpad and keyboard | types text and presses keys on it |
| Presenter | a phone moves the pointer as a slide remote | — |

Devices are found by UDP broadcast and over mDNS (`_kdeconnect._udp`), or reached by address. Not yet: Bluetooth.
Contacts and messages are kept while the daemon runs and fetched again when the phone connects.

### This computer and Home Assistant

These plugins read the computer the daemon runs on and offer its controls. Their readings and controls show under
This computer and through the API and MCP (`list_readings`, `set_control`). Once Settings → Home Assistant links to
an MQTT broker, they are published to Home Assistant with MQTT discovery, under one device named after the computer.

| Plugin | Readings | Controls |
| --- | --- | --- |
| Processor and memory | processor and graphics load, load average, memory and swap used, when it started, restart needed | — |
| Disks | how full each disk is, read and write speed | — |
| Network | download and upload per card, IP address, Wi-Fi signal | — |
| Temperatures | every hwmon sensor | — |
| Power | battery and charging | shut down, restart, suspend, hibernate, keep awake, power profile, screen brightness |
| Session | idle time, user, camera, microphone and speakers in use | locked |
| Desktop controls | the media playing, the clipboard (off unless turned on) | notifications from Home Assistant, open a link, type text, play or pause, next, previous, volume, mute, sound output |
| Command buttons | — | a button for each run command |
| Services | whether each systemd unit named runs | start and stop it |

A sleeping NVIDIA card in a laptop is left asleep rather than woken by `nvidia-smi`. LNXlink modules not yet taken
over are listed in [docs/TODO.md](docs/TODO.md).

### System Bridge

Settings → System Bridge runs a server that speaks System Bridge's API (port 9170 by default), so Home Assistant's
own System Bridge integration reads and controls this computer as it would one running the System Bridge app. It
advertises itself over mDNS for Home Assistant to find, and clients sign in with a key made in Settings or by
trading a pairing code for one.

- Data: system (with the machine's maker and model, idle time, lock and a restart waiting), processor, memory, disks
  with read and write speeds, network cards, battery, graphics cards, media, processes and sound outputs.
- Controls: power buttons, lock, run commands, keys and text typed, opening paths and links, media, volume,
  mute and sound output, power profile, keep awake, notifications, and the clipboard.
- Media: the home folder's Documents, Downloads, Music, Pictures and Videos, browsed and played through signed links.

Not yet: displays, audio inputs, Bluetooth, cameras and windows; see [docs/TODO.md](docs/TODO.md).

## Running it

`nix-shell` (or `nix develop`) gives Node 24 and an Electron that runs on NixOS; then `npm install`.

- `npm run dev:server` runs the daemon against [config.example.json](config.example.json), on a pretend computer and
  off the network's usual ports, so it never touches your desktop or your own KDE Connect devices.
- `npm run dev:web` serves the page with hot reloading on the dev server's API.
- `npm run dev:phone` runs a pretend phone that connects to the dev server, asks to pair and, once you accept, sends
  notifications, its signal, its battery and its media players.
- `npm run dev` runs the desktop app on a profile of its own under `dev-data/`.

Sign in to a server with an account from `npm run hash-password -- <name>`, which writes the file
`X_CONTROL_PASSWORD_HASH_FILE` names.

## The server

`npm start` with `X_CONTROL_CONFIG` naming a JSON config:

| Key | Meaning | Default |
| --- | --- | --- |
| `database` | the SQLite file | required |
| `backups_folder`, `identity_file`, `downloads_folder`, `mounts_folder`, `plugins_folder` | where those live | beside the database |
| `device_name`, `device_type` | how other devices see this one | the host name, `desktop` |
| `system` | `linux` drives the desktop, `sample` a pretend one | `linux` |
| `kdeconnect.discovery` | find devices by broadcast | `true` |
| `kdeconnect.mdns` | also find and advertise over mDNS, while discovery is on | `true` |
| `kdeconnect.listen_port`, `announce_port` | the UDP ports | `1716` |
| `kdeconnect.tcp_ports`, `payload_ports` | `[lowest, highest]` | `[1716, 1764]`, `[1739, 1764]` |
| `notify_channels` | ntfy, webhook, mail or Apprise entries | none |
| `system_bridge` | `enabled`, `port`; Settings overrides each it sets | off, `9170` |
| `home_assistant` | `enabled`, `broker`, `username`, `password_file` (or `password_credential`, a systemd credential's name), `discovery_prefix`, `base_topic`, `interval`; Settings overrides each field it sets | off |

NixOS hosts use `services.x-control` from the flake's `nixosModules.default`. Phones and desktops reach the server's
KDE Connect side on UDP and TCP 1716 to 1764, which `openFirewall` opens. `services.x-control.homeAssistant` links the
server to Home Assistant, its `passwordFile` handed over as a systemd credential, and
`services.x-control.systemBridge` runs the System Bridge server, with `openFirewall` for its port.

## Desktop app

The desktop app starts its own daemon on a Unix socket, which keeps devices connected with the window closed and
shows their notifications on the desktop. It drives the desktop through the programs every desktop ships:
`wl-clipboard` or `xclip`, `playerctl`, `pactl`, `loginctl`, `xdg-open`, `canberra-gtk-play`, `ydotool` (with its
daemon) on Wayland or `xdotool` on X11 for remote input, and `sshfs` for a phone's files. This computer's readings
come from `/proc` and `/sys`, with `nmcli`, `nvidia-smi`, `powerprofilesctl`, `brightnessctl`, `systemd-inhibit` and
`systemctl` where present. A feature whose
program is missing reports that in plain words and the rest keep working.

## Deviations from the standard

- **The Android app has no daemon of its own**, so it is a portal onto a daemon on another computer, chosen under
  Settings → Connections. Android cannot keep a Node daemon running, and a phone talks KDE Connect through the
  KDE Connect app itself.
- **Paired devices do not sync.** Each daemon has its own certificate, and the protocol pairs a phone with each one
  on its own. The run commands, the settings and their history sync.
- **Notifications on the phone app**: the phone app shows none while closed; its daemon is the one that notifies,
  through the desktop or the server's channels.

## Plugins and trust

Plugins in the plugins folder (`plugins/` beside the database, or in the desktop profile) run with X-Control's full
rights and are not sandboxed; install only plugins you trust. Each subfolder holds a `package.json` with
`"x-plugin": { "server": "dist/server.js", "web": "dist/web.js" }`. A server-side plugin provides a `capability`
that takes and sends KDE Connect packets; a page-side one fills a device's `device_panel` slot.

Paired devices can run the commands listed under Commands as the daemon's user, lock or unlock its session, and move
its pointer and type on it while Remote input is on. A phone's SFTP password is used once to mount and never kept.
Pairing needs the user's acceptance on both sides, with the same verification key shown on each screen.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
