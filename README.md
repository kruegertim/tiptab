# tiptab – Bildschirmtastatur für GNOME (Ubuntu 24.04, GNOME Shell 46, Wayland)

An On-Screen-Keyboard for tablet use, optimized right now for the Lenovo Miix 520 tablet and GNOME Wayland.
(GNOME-Erweiterung `tablet-osk@kruegertim`.)

Vollständige Bildschirmtastatur im ThinkPad-Stil: F-Reihe mit Fn-Ebene (Medientasten), Pos1/Ende/Einfg/Entf,
Bild↑/Bild↓, Pfeiltasten, AltGr-Zeichen, QWERTZ oder QWERTY.

## Funktionen
- Blendet sich automatisch ein, wenn ein Textfeld angetippt wird, und aus, wenn der Fokus verloren geht
  oder ein einzeiliges Feld mit Enter abgeschickt wurde.
- Wischen vom unteren Bildschirmrand nach oben blendet ein, Wischen nach unten auf den Tasten blendet aus
  (Touch und Maus). Symbol in der oberen Leiste zum Umschalten. Taste mit Tastatur-Symbol blendet aus.
- Keine automatische Einblendung, solange eine externe Tastatur (USB/Bluetooth/Tastatur-Cover) angeschlossen ist.
- „Inhalt verkleinern“: im angedockten Modus wird die Arbeitsfläche verkleinert, Fenster bleiben vollständig sichtbar.
  Das Ubuntu-Dock wandert nach links, solange die Tastatur sichtbar ist.
- Schwebend-Modus: frei verschiebbar (Griffleiste), Größe über die Ecke unten rechts, einstellbare Deckkraft.
- Vorschlagsleiste, Autokorrektur (Rücktaste macht sie rückgängig) und unsichtbar angepasste Trefferflächen,
  Deutsch und Englisch. Gelernte Wörter bleiben lokal, in Passwortfeldern wird nichts gelernt.
- Umschalttasten: antippen = für die nächste Taste, gehalten = solange gedrückt.
- Einstellungen direkt in der Tastatur (Zahnrad) oder im Erweiterungen-Programm; beide nutzen dieselben Einstellungen.
- Tastenhöhe in Millimetern (Standard 11,5 mm), umgerechnet über die physische Bildschirmgröße.

## Installation
    ./install.sh
    # einmal ab- und wieder anmelden (Wayland), dann:
    gnome-extensions enable tablet-osk@kruegertim

Aktualisieren: `git pull && ./install.sh`, danach ab- und wieder anmelden.
Entfernen: `./install.sh --uninstall` (mit `--purge` auch Einstellungen und gelernte Wörter).

Installierbares Zip (ohne Git auf dem Zielgerät): `packaging/build-zip.sh` erzeugt
`dist/tablet-osk@kruegertim.shell-extension.zip`, installieren mit
`gnome-extensions install --force <zip>`. Details in `packaging/README.md`.

Ausführliche Anleitung für das Tablet: [docs/installation-miix.md](docs/installation-miix.md).
Testliste zum Abhaken: [docs/touch-test-checkliste.md](docs/touch-test-checkliste.md).

## Hinweise
- Die eingebaute GNOME-Bildschirmtastatur wird unterdrückt, solange die Erweiterung aktiv ist.
- Erkennung externer Tastaturen: Geräte werden mit Präfix `[tablet-osk]` im Journal protokolliert
  (`journalctl --user -b | grep tablet-osk`). Ein Logitech-USB-Empfänger zählt als Tastatur; zum Testen am Laptop
  in den Einstellungen „Physische Tastatur ignorieren“ einschalten.

Aufbau der Module: siehe `CONTRACT.md`.

## Projektstand / Branches
- `main`: installierbare, getestete Version (GNOME Shell 46, Ubuntu 24.04, Wayland).
- `wip/next`: in Arbeit – Vorschlagsleiste, Autokorrektur, dynamische Trefferflächen, DE/EN-Wörterbücher,
  neue Tastenbeschriftung, Halte-Logik für Umschalttasten.

## Lizenz
Code: GNU General Public License v3.0 (siehe `LICENSE`). Wörterbuchdaten (Branch `wip/next`, `predict/data/`): CC-BY-SA 4.0,
Details in `tools/DATA_LICENSES.md`.
