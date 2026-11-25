{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_24 # Runs the server's .ts files directly and builds the page.
    electron_45 # The desktop app; the npm-downloaded Electron cannot run on NixOS.
    git
  ];

  shellHook = ''
    # VSCode's terminal exports this, which makes Electron run as bare node and die on the ESM main.
    unset ELECTRON_RUN_AS_NODE
    export ELECTRON_SKIP_BINARY_DOWNLOAD=1
    export ELECTRON_OVERRIDE_DIST_PATH="${pkgs.electron_45}/libexec/electron"
    export ELECTRON_EXEC_PATH="${pkgs.electron_45}/bin/electron"
  '';
}
