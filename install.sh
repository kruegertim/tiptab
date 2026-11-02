#!/bin/bash
# Installiert, aktualisiert oder entfernt die Bildschirmtastatur für den aktuellen
# Benutzer (kein sudo nötig). Ausführliche Anleitung: docs/installation-miix.md
#
#   ./install.sh               installieren bzw. aktualisieren (direkt aus diesem Ordner)
#   ./install.sh --zip         erst Zip bauen (packaging/build-zip.sh), dann über
#                              `gnome-extensions install` installieren
#   ./install.sh --uninstall   Erweiterung ausschalten und entfernen
#   ./install.sh --uninstall --purge
#                              zusätzlich Einstellungen und gelernte Wörter löschen
set -euo pipefail

UUID=tablet-osk@kruegertim
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
USERDATA="${XDG_DATA_HOME:-$HOME/.local/share}/tablet-osk"
DCONF_PATH=/org/gnome/shell/extensions/tablet-osk/

MODE=install
PURGE=0
for arg in "$@"; do
    case "$arg" in
        --zip) MODE=zip ;;
        --uninstall) MODE=uninstall ;;
        --purge) PURGE=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "Unbekannte Option: $arg (siehe ./install.sh --help)" >&2; exit 2 ;;
    esac
done
if [ "$PURGE" = 1 ] && [ "$MODE" != uninstall ]; then
    echo "--purge geht nur zusammen mit --uninstall" >&2; exit 2
fi

have() { command -v "$1" >/dev/null 2>&1; }

was_enabled=0
if have gnome-extensions && gnome-extensions list --enabled 2>/dev/null | grep -qx "$UUID"; then
    was_enabled=1
fi

finish_hint() {
    echo
    if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
        echo "Wayland: GNOME lädt Erweiterungen nur beim Anmelden neu."
        echo "Bitte einmal ab- und wieder anmelden."
    else
        echo "X11: Alt+F2, 'r' eingeben, Enter (oder ab- und wieder anmelden)."
    fi
    if [ "$was_enabled" = 1 ]; then
        echo "Die Erweiterung ist bereits eingeschaltet und bleibt es."
    else
        echo "Danach einschalten mit:"
        echo "  gnome-extensions enable $UUID"
    fi
}

case "$MODE" in
install)
    have glib-compile-schemas || { echo "Fehlt: glib-compile-schemas (sudo apt install libglib2.0-bin)" >&2; exit 1; }
    glib-compile-schemas --strict "$SRC/schemas"
    # Alten Stand komplett ersetzen, damit keine gelöschten Dateien liegen bleiben.
    # Gelernte Wörter liegen getrennt in $USERDATA und bleiben erhalten.
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cp -r "$SRC/." "$DEST/"
    rm -f "$DEST/predict/package.json"
    echo "Installiert nach $DEST"
    finish_hint
    ;;
zip)
    have gnome-extensions || { echo "Fehlt: gnome-extensions (Paket gnome-shell)" >&2; exit 1; }
    "$ROOT/packaging/build-zip.sh"
    gnome-extensions install --force "$ROOT/dist/$UUID.shell-extension.zip"
    echo "Installiert über gnome-extensions nach $DEST"
    finish_hint
    ;;
uninstall)
    if [ "$was_enabled" = 1 ]; then
        gnome-extensions disable "$UUID" || true
    fi
    if have gnome-extensions && gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
        gnome-extensions uninstall "$UUID" || rm -rf "$DEST"
    else
        rm -rf "$DEST"
    fi
    echo "Entfernt: $DEST"
    if [ "$PURGE" = 1 ]; then
        if have dconf; then dconf reset -f "$DCONF_PATH"; fi
        rm -rf "$USERDATA"
        echo "Einstellungen ($DCONF_PATH) und gelernte Wörter ($USERDATA) gelöscht."
    else
        echo "Einstellungen und gelernte Wörter bleiben erhalten (löschen mit --uninstall --purge)."
    fi
    echo "Nach dem nächsten Ab- und Anmelden ist die Tastatur ganz verschwunden;"
    echo "die eingebaute GNOME-Bildschirmtastatur gilt dann wieder."
    ;;
esac
