# Architecture

## Layout

| Folder | Holds |
| --- | --- |
| `src/shared` | the store (settings, paired devices, run commands, history), packet shapes, plugin manifests and states, the page's API types |
| `src/server/kdeconnect` | the KDE Connect protocol: identity and certificate, LAN discovery and handshake, links and payloads, the device manager |
| `src/server/plugins` | the bundled plugins, one file each, on the X-Libs plugin host |
| `src/server/system` | what plugins ask of the computer: the Linux desktop and its readings, or a pretend one for tests and the dev server |
| `src/server/computer` | this computer's readings and controls, gathered from every plugin's entities |
| `src/server/home_assistant` | the MQTT bridge that publishes them to Home Assistant |
| `src/server/system_bridge` | a System Bridge server: its keys, data modules, media folders, HTTP and WebSocket API |
| `src/server` | the control core (`control.ts`), the web server and its config |
| `src/daemon` | the desktop app's daemon, on a Unix socket |
| `src/main`, `src/preload` | Electron's window, tray and login entry |
| `src/web` | the React page every target draws |

## KDE Connect, protocol version 8

- A device broadcasts its identity over UDP to port 1716. A device that hears it connects over TCP to the port in
  it and sends its own identity in plain text, naming the device it meant.
- TLS then starts with the roles reversed: the device that connected takes the server's part. Certificates are
  self-signed EC P-256, their common name the device id. A paired device must show the certificate it was paired
  with; an unpaired one is trusted for now and may only ask to pair.
- Devices are also advertised and found over mDNS as `_kdeconnect._udp`, named by id with `id`, `name`, `type` and
  `protocol` in TXT; a device found that way is sent this one's identity over UDP, as after a broadcast.
- Over TLS both sides send their identity again; a device whose id or version changed, or whose certificate names
  another device, is refused.
- Pairing sends `kdeconnect.pair` with the request's time; both sides show the first eight hex digits of SHA-256 over
  both public keys, the larger first, and that time. An unanswered request lapses after 30 seconds.
- A packet with a payload offers it on a port of its own; the receiver connects and takes TLS's client part, and the
  certificate must be the same as on the link.

## Plugins

A daemon plugin provides a `capability`: the packet types it takes and sends (announced in this device's identity),
what to do when a paired device connects or sends one, and named actions the page, the API and MCP run through
`run_device_action`. What it learns of a device it keeps as that device's state, which the page reads under
`plugins.<id>`. A page plugin with the same manifest fills the device page's `device_panel` slot. On or off and each
plugin's settings are kept in the `plugins` setting, which both sides read.

A capability marked `keep_state` has what it knows of a paired device kept in the `device_states` table, such as a
phone's contacts and messages. The table never syncs. Its rows load back when the device is next asked for, and go
when it is unpaired.

A plugin can also provide `entities`: readings and controls of this computer, each with a kind Home Assistant knows
(sensor, binary_sensor, switch, button, number, select or text), listed again every minute and whenever plugins or
run commands change, since disks and network cards come and go. The readings registry reads each when it falls due,
its own `every` or the interval in Settings, shares one pass between callers, and fails a read after ten seconds.

## Home Assistant

The bridge keeps one MQTT connection, with a retained last will of `offline` on `<base_topic>/<device id>/status`.
Each entity's config goes to `<prefix>/<kind>/x_control_<device id>/<plugin>_<entity>/config`, retained. Its value
goes to `.../state`, its attributes to `.../attributes`, and commands arrive on `.../set`. Values are published as they
change. Everything is announced again when `<prefix>/status` says `online`. A retained config under this device's node
that no entity has now is cleared. The connection is tried again with backoff from one second to a minute.

## System Bridge

The server copies System Bridge 5.31's API as Home Assistant's integration (connector 5.29) reads it:

- `/api/health` without a key, reporting version 5.31.3, since Home Assistant needs 5.28.6 or newer.
- `/api/websocket`, signed in by one `{"type":"auth","key":...}` frame; a wrong key gets `BAD_KEY` and the socket closes.
- Every frame carries only `id`, `type`, `subtype`, `data`, `message` and `module`, since the connector refuses any other key.
- `GET_DATA` answers every module asked for, never with null.
- `REGISTER_DATA_LISTENER` sends a snapshot at once. After that, changed modules are pushed every 10 s for media,
  battery and audio, and every 30 s for the rest.
- Keys follow System Bridge's `system-bridge_client_<43><checksum>` format, and only their SHA-256 hashes are kept,
  in `system-bridge-keys.json` beside the identity. Pairing codes last ten minutes, in memory.
- The uuid clients know the computer by is its KDE Connect id written as a UUID. The same uuid is in the mDNS TXT
  record of `_system-bridge._tcp`, with `ip` and `port`.
- Media folders are the home folder's usual ones. A path is followed through links and refused outside its folder.
  Files are served by HMAC-signed links that last a day at most.

## Next

- Keeping contacts and messages in the store, so they show while the phone is away.
- A daemon on every computer reporting to a central one, so the page shows every machine.
