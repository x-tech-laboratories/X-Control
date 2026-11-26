{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  electron_45,
  makeWrapper,
  copyDesktopItems,
  makeDesktopItem,
  python3,
  node-gyp,
}:

buildNpmPackage {
  pname = "x-control-desktop";
  version = (lib.importJSON ../package.json).version;
  src = lib.cleanSource ../.;

  nodejs = nodejs_24;
  # Read from package-lock.json, so there is no deps hash to keep in step with it.
  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
    python3
    node-gyp
  ];

  # The daemon runs on Electron's own Node, so usocket, which passes Bluetooth sockets over D-Bus, is built for it.
  preBuild = ''
    npm_config_nodedir=${electron_45.headers} node ${node-gyp}/lib/node_modules/node-gyp/bin/node-gyp.js rebuild --directory=node_modules/usocket --nodedir=${electron_45.headers}
  '';

  npmBuildScript = "build:desktop";

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --ignore-scripts
    mkdir -p $out/lib/x-control-desktop
    cp -r out package.json node_modules resources $out/lib/x-control-desktop/
    install -Dm644 resources/icon.png $out/share/icons/hicolor/512x512/apps/x-control.png
    makeWrapper ${lib.getExe electron_45} $out/bin/x-control-desktop \
      --add-flags $out/lib/x-control-desktop \
      --unset ELECTRON_RUN_AS_NODE \
      --set X_CONTROL_LAUNCHER x-control-desktop

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "x-control";
      desktopName = "X-Control";
      comment = "Reach and control your phones and computers";
      exec = "x-control-desktop %U";
      icon = "x-control";
      categories = [ "Utility" ];
      # Opens x-control://<page> links, such as a notification's, in the app.
      mimeTypes = [ "x-scheme-handler/x-control" ];
    })
  ];

  meta = {
    description = "X-Control as a desktop app with its own daemon";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-control-desktop";
  };
}
