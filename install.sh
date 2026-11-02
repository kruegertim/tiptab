#!/bin/bash
# Installiert die Erweiterung für den aktuellen Benutzer (kein sudo nötig).
set -euo pipefail
UUID=tablet-osk@kruegertim
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
glib-compile-schemas "$SRC/schemas"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"
echo "Installiert nach $DEST"
echo "Unter Wayland einmal ab- und wieder anmelden, danach:"
echo "  gnome-extensions enable $UUID"
