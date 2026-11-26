# X-Control to-do

## Android

- Build X-Control's own Android app on Capacitor that is a KDE Connect device itself, fully peer to peer. Phones and
  computers then talk to each other directly, with no X-Control server or daemon in between, as the KDE Connect app
  does. Today the Android app is only a page onto a daemon it signs in to under Connections.
  - A native Capacitor plugin for the network side: UDP discovery and mDNS, TCP with TLS in the reversed roles, the
    payload ports, and the certificate kept in the Android keystore.
  - The protocol and plugin logic shared with the daemon where it can be, so a feature is written once.
  - A foreground service that keeps devices connected with the app closed, and Android's own services behind
    `SystemServices`: notifications, battery, clipboard, media sessions, telephony, SMS and contacts, files over SFTP.
  - Pairing, the verification key and trusted certificates the same as on the desktop, so it pairs with KDE Connect,
    Valent, GSConnect and X-Control daemons.

## KDE Connect

Left before X-Control can replace Valent on a desktop:

- Try Bluetooth with a real phone, KDE Connect and Valent; everything so far ran against a pretend BlueZ and descriptors passed on a private bus.
- Move off `process.binding("pipe_wrap")`, which Node may drop, if it does: the descriptor would then go through a file stream, whose pending read keeps the daemon from exiting.
- Keep a phone's contacts where the desktop's apps see them, in Evolution Data Server (Valent's `eds` plugin). Valent on Odin keeps no address book there, so nothing uses it yet.
- Mute the microphone during a call, once `SystemServices` reaches sound inputs.
- Check mDNS discovery against Valent and the KDE Connect app on a network that answers mDNS.
- Try SFTP, remote input and messages with a real phone.

## LNXlink modules not yet taken over

The common modules are plugins under This computer. These are still to do:

- Screenshot and webcam as Home Assistant camera or image entities.
- The active window and whether it is full screen, and the screen on or off (each desktop and Wayland says so in its own way).
- Do not disturb and night light, per desktop (GNOME through gsettings, KDE through its own settings).
- Docker containers as switches, with an update check.
- System updates waiting, from the package manager or `nixos-rebuild`.
- Mounts of shares, Bluetooth devices and their batteries, Wi-Fi networks to join.
- Keyboard hotkeys that fire Home Assistant events, and the mouse moved from Home Assistant.
- Boot selection for the next restart, and Wake-on-LAN of other machines (X-Libs has `agent/wake`).
- Steam games, gamepads, GPIO, IR remotes, fingerprint readers, speech recognition and BeaconDB location.
- MQTT notify entities, once X-Libs' `mqtt_discovery` knows the `notify` component; notifications use a text entity now.

## System Bridge

The server covers what Home Assistant's integration uses. Still to do:

- Displays, with brightness and power (`DISPLAY_CONTROL`), from wlr-randr, kscreen-doctor or xrandr.
- Audio inputs and per-app streams in the audio module.
- Shuffle and repeat for media, and a thumbnail of what plays.
- Process CPU and memory use, and `PROCESS_KILL`.
- Telling clients `POWER_STATE_CHANGED` resumed after the computer wakes, and announcing over mDNS again then.
- Bluetooth, cameras, the desktop's windows and workspaces, Hyprland, Omarchy and Discord, which System Bridge offers beyond what Home Assistant uses.
- Its own web page, MCP endpoint and push notifications.
