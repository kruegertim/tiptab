#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Lets Chrome/Chromium-based browsers report text fields to GNOME under Wayland, so the
# tablet-osk keyboard auto-shows when a web form field is tapped.
#
# Chrome only sends text-input events (Wayland protocol text-input-v3) to the shell when
# started with --enable-wayland-ime. Without it, tapping a field never reaches GNOME and
# no on-screen keyboard (ours or GNOME's) can react. GTK apps, Firefox and shell dialogs
# don't need this.
#
# The script writes per-user copies of the browsers' .desktop files to
# ~/.local/share/applications with the flags added to every Exec line. Nothing outside
# your home folder is changed.
#
#   tools/chrome-wayland-ime.sh            add the flags
#   tools/chrome-wayland-ime.sh --remove   remove the per-user copies again
#
# Afterwards quit the browser completely (also from the background / tray) and start it
# again from the dock or app grid.
set -euo pipefail

FLAGS="--ozone-platform-hint=auto --enable-wayland-ime --wayland-text-input-version=3"
MARK="X-TabletOsk-WaylandIme=true"
DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

NAMES=(
    google-chrome.desktop
    google-chrome-beta.desktop
    google-chrome-unstable.desktop
    chromium.desktop
    chromium-browser.desktop
    chromium_chromium.desktop
    microsoft-edge.desktop
    brave-browser.desktop
    vivaldi-stable.desktop
)
SYSTEM_DIRS=(
    /usr/share/applications
    /usr/local/share/applications
    /var/lib/snapd/desktop/applications
    /var/lib/flatpak/exports/share/applications
)

remove=0
case "${1:-}" in
    --remove) remove=1 ;;
    "") ;;
    *) echo "Aufruf: $0 [--remove]" >&2; exit 2 ;;
esac

mkdir -p "$DEST_DIR"
found=0
for name in "${NAMES[@]}"; do
    dest="$DEST_DIR/$name"
    if [ "$remove" = 1 ]; then
        if [ -f "$dest" ] && grep -qx "$MARK" "$dest"; then
            rm -f "$dest"
            echo "Entfernt: $dest"
            found=1
        fi
        continue
    fi

    src=""
    for d in "${SYSTEM_DIRS[@]}"; do
        if [ -f "$d/$name" ]; then
            src="$d/$name"
            break
        fi
    done
    [ -n "$src" ] || continue
    found=1

    if [ -f "$dest" ] && ! grep -qx "$MARK" "$dest"; then
        echo "Übersprungen: $dest existiert schon (eigene Anpassung, nicht von diesem Skript)." >&2
        continue
    fi

    # Add the flags right after the program on every Exec= line (idempotent: the
    # copy is always rebuilt from the system file). The marker goes into the
    # [Desktop Entry] group, right after its header line.
    awk -v flags="$FLAGS" -v mark="$MARK" '
        /^\[Desktop Entry\]$/ { print; print mark; next }
        /^Exec=/ {
            line = substr($0, 6)
            n = index(line, " ")
            if (n == 0) { print "Exec=" line " " flags }
            else { print "Exec=" substr(line, 1, n - 1) " " flags substr(line, n) }
            next
        }
        { print }
    ' "$src" > "$dest.tmp"
    mv "$dest.tmp" "$dest"
    echo "Angepasst: $dest (aus $src)"
done

if [ "$found" = 0 ]; then
    if [ "$remove" = 1 ]; then
        echo "Nichts zu entfernen."
    else
        echo "Kein Chrome/Chromium-Browser gefunden."
    fi
    exit 0
fi

command -v update-desktop-database >/dev/null && update-desktop-database "$DEST_DIR" 2>/dev/null || true
if [ "$remove" = 0 ]; then
    echo
    echo "Jetzt den Browser ganz beenden (auch im Hintergrund, z. B. pkill -f /opt/google/chrome)"
    echo "und über Dock oder App-Übersicht neu starten. Prüfen: chrome://gpu → \"Ozone platform: wayland\"."
fi
