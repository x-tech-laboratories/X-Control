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

- Bluetooth as a second way to reach devices.
- Keep contacts and messages in the store, so they show while the phone is away.
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

- This computer's readings and controls over System Bridge's WebSocket API, from the same readings registry, so its
  Home Assistant integration and clients work against X-Control.
