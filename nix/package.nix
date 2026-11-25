{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-control";
  version = (lib.importJSON ../package.json).version;
  src = lib.cleanSource ../.;

  nodejs = nodejs_24;
  # Read from package-lock.json, so there is no deps hash to keep in step with it.
  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [ makeWrapper ];

  # Node will not run .ts files from under a node_modules folder, so the app lives in lib/x-control.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --ignore-scripts

    mkdir -p $out/lib/x-control/src $out/lib/x-control/out
    cp -r package.json node_modules $out/lib/x-control/
    cp -r out/web $out/lib/x-control/out/
    cp -r src/server src/shared $out/lib/x-control/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-control \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/x-control/src/server/main.ts" \
      --set-default NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "Reach and control your phones and computers over KDE Connect";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-control";
  };
}
