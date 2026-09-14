{
  pkgs ? import (fetchTarball "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz") { },
}:

pkgs.mkShell {
  packages = with pkgs; [
    # Rust
    rustc
    cargo
    cargo-tauri
    rustfmt
    clippy

    # Node / pnpm
    nodejs
    pnpm

    # Tauri Linux runtime deps
    pkg-config
    wrapGAppsHook4
    glib-networking
    webkitgtk_4_1
    gst_all_1.gst-plugins-base
    openssl
    librsvg
  ];

  shellHook = ''
    export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
    export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH" # Needed on Wayland to report the correct display scale
  '';
}
