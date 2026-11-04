# tiptab – Bildschirmtastatur für GNOME (Ubuntu 24.04, GNOME Shell 46, Wayland)

An On-Screen-Keyboard for tablet use, optimized right now for the Lenovo Miix 520 tablet and GNOME Wayland.
(GNOME-Erweiterung `tablet-osk@kruegertim`.)

Vollständige Bildschirmtastatur im ThinkPad-Stil: F-Reihe mit Fn-Ebene (Medientasten), Pos1/Ende/Einfg/Entf,
Bild↑/Bild↓, Pfeiltasten, AltGr-Zeichen, QWERTZ oder QWERTY.

## Funktionen
- Blendet sich automatisch ein, wenn ein Textfeld angetippt wird, und aus, wenn der Fokus verloren geht.
- Wischen vom unteren Bildschirmrand nach oben blendet ein, Wischen auf der Griffleiste nach unten blendet aus
  (Touch und Maus). Symbol in der oberen Leiste zum Umschalten. Taste mit Tastatur-Symbol blendet aus.
- Keine automatische Einblendung, solange eine externe Tastatur (USB/Bluetooth/Tastatur-Cover) angeschlossen ist.
- „Inhalt verkleinern“: im angedockten Modus wird die Arbeitsfläche verkleinert, Fenster bleiben vollständig sichtbar.
- Schwebend-Modus: frei verschiebbar (Griffleiste), Größe über die Ecke unten rechts, einstellbare Deckkraft.
- Einstellungen direkt in der Tastatur (Zahnrad) oder im Erweiterungen-Programm; beide nutzen dieselben Einstellungen.
- Tastenhöhe in Millimetern (Standard 11,5 mm), umgerechnet über die physische Bildschirmgröße.

## Installation
    ./install.sh
    # einmal ab- und wieder anmelden (Wayland), dann:
    gnome-extensions enable tablet-osk@kruegertim

Deinstallation: `gnome-extensions disable tablet-osk@kruegertim` und den Ordner
`~/.local/share/gnome-shell/extensions/tablet-osk@kruegertim` löschen.

## Hinweise
- Die eingebaute GNOME-Bildschirmtastatur wird unterdrückt, solange die Erweiterung aktiv ist.
- Erkennung externer Tastaturen: Geräte werden mit Präfix `[tablet-osk]` im Journal protokolliert
  (`journalctl --user -b | grep tablet-osk`). Ein Logitech-USB-Empfänger zählt als Tastatur; zum Testen am Laptop
  in den Einstellungen „Physische Tastatur ignorieren“ einschalten.

- Chrome, Chromium, Edge, Brave: Diese Browser melden Webformular-Felder unter Wayland nur mit der Startoption
  `--enable-wayland-ime` an GNOME, sonst blendet sich die Tastatur beim Antippen nicht ein. `tools/chrome-wayland-ime.sh`
  legt dafür angepasste Starter in `~/.local/share/applications` an (`--remove` macht es rückgängig). Danach den Browser
  ganz beenden und neu starten. Firefox, GTK-Apps und Systemdialoge brauchen das nicht.

Aufbau der Module: siehe `CONTRACT.md`.

## Projektstand / Branches
- `main`: installierbare, getestete Version (GNOME Shell 46, Ubuntu 24.04, Wayland).
- `wip/next`: in Arbeit – Vorschlagsleiste, Autokorrektur, dynamische Trefferflächen, DE/EN-Wörterbücher,
  neue Tastenbeschriftung, Halte-Logik für Umschalttasten.

## Lizenz
Code: GNU General Public License v3.0 (siehe `LICENSE`). Wörterbuchdaten (Branch `wip/next`, `predict/data/`): CC-BY-SA 4.0,
Details in `tools/DATA_LICENSES.md`.

Tux-Figur nach Larry Ewing (eigene, vereinfachte Zeichnung in `icons/tux-symbolic.svg`).
