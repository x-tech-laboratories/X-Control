self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-control;
  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  state_directory = "/var/lib/x-control";

  config_file = (pkgs.formats.json { }).generate "x-control.json" {
    database = "${state_directory}/control.db";
    backups_folder = "${state_directory}/backups";
    device_name = cfg.deviceName;
    kdeconnect = { discovery = cfg.discovery; };
    notify_channels = cfg.notifyChannels;
    home_assistant = {
      enabled = cfg.homeAssistant.enable;
      broker = cfg.homeAssistant.broker;
      username = cfg.homeAssistant.username;
      discovery_prefix = cfg.homeAssistant.discoveryPrefix;
      base_topic = cfg.homeAssistant.baseTopic;
    }
    // lib.optionalAttrs (cfg.homeAssistant.passwordFile != null) {
      # systemd hands the password over as a credential, so the dynamic user can read it.
      password_credential = "mqtt-password";
    };
  };
in
{
  options.services.x-control = {
    enable = mkEnableOption "X-Control, which reaches phones and computers over KDE Connect and controls them from a web page";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = literalExpression "x-control (from flake)";
      description = "The X-Control package to use.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address the page, API and sync listen on.";
    };

    port = mkOption {
      type = types.port;
      default = 7780;
      description = "Port the page, API and sync listen on.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the page's port, and KDE Connect's ports (UDP and TCP 1716 to 1764), in the firewall.";
    };

    deviceName = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "Home server";
      description = "The name phones and computers show for this server; the host name when unset.";
    };

    discovery = mkOption {
      type = types.bool;
      default = true;
      description = "Find devices on the local network by broadcast; off, they are reached only by address.";
    };

    notifyChannels = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
      example = literalExpression ''[ { type = "ntfy"; url = "https://ntfy.sh"; topic = "my-devices"; } ]'';
      description = "Where the server's notifications go, such as a phone's pairing request: ntfy, webhook, mail or Apprise entries, each secret read from a file.";
    };

    homeAssistant = {
      enable = mkEnableOption "publishing this server's readings and controls to Home Assistant over MQTT; Settings on the page can still change it";

      broker = mkOption {
        type = types.str;
        default = "";
        example = "mqtt://homeassistant.local:1883";
        description = "The MQTT broker Home Assistant listens on, as mqtt:// or mqtts://.";
      };

      username = mkOption {
        type = types.str;
        default = "";
        description = "The name X-Control signs in to the broker with.";
      };

      passwordFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "/var/lib/secrets/x-control-mqtt";
        description = "A file holding the broker's password.";
      };

      discoveryPrefix = mkOption {
        type = types.str;
        default = "homeassistant";
        description = "The topic Home Assistant reads MQTT discovery from.";
      };

      baseTopic = mkOption {
        type = types.str;
        default = "x-control";
        description = "The topic this server's readings are published under, followed by its KDE Connect id.";
      };
    };

    passwordHashFile = mkOption {
      type = types.str;
      example = "/etc/x-control/password-hash";
      description = ''
        The accounts file: one `name:hash` line per admin, from `npm run hash-password`. Admins add other users on the
        Users page.
      '';
    };
  };

  config = mkIf cfg.enable {
    systemd.services.x-control = {
      description = "X-Control";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        X_CONTROL_CONFIG = toString config_file;
        X_CONTROL_HOST = cfg.host;
        X_CONTROL_PORT = toString cfg.port;
        X_CONTROL_PASSWORD_HASH_FILE = "%d/password-hash";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "x-control";
        StateDirectoryMode = "0700";
        LoadCredential = [
          "password-hash:${cfg.passwordHashFile}"
        ]
        ++ lib.optional (cfg.homeAssistant.passwordFile != null) "mqtt-password:${cfg.homeAssistant.passwordFile}";
        Restart = "always";
        RestartSec = "5s";

        CapabilityBoundingSet = "";
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        UMask = "0077";
      };
    };

    networking.firewall = mkIf cfg.openFirewall {
      allowedTCPPorts = [ cfg.port ];
      allowedTCPPortRanges = [ { from = 1716; to = 1764; } ];
      allowedUDPPortRanges = [ { from = 1716; to = 1764; } ];
    };
  };
}
