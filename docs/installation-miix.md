# Installation auf dem Lenovo Miix 520 (Ubuntu 24.04)

Diese Anleitung bringt die Bildschirmtastatur `tablet-osk@kruegertim` auf das Tablet und erklärt
Aktualisieren und Entfernen. Alles läuft als normaler Benutzer, `sudo` ist nur für fehlende
Pakete nötig.

## Voraussetzungen prüfen

Im Terminal auf dem Miix:

    lsb_release -d               # Ubuntu 24.04.x LTS
    gnome-shell --version        # GNOME Shell 46.x
    echo $XDG_SESSION_TYPE       # wayland

Die Erweiterung ist nur für GNOME Shell 46 freigegeben. Unter X11 funktioniert sie
grundsätzlich auch, getestet ist aber Wayland.

Benötigte Pakete (auf einem normalen Ubuntu-Desktop schon vorhanden, außer `git`):

    sudo apt install git libglib2.0-bin gnome-shell-extension-prefs zip

Tipp: Solange auf dem Miix noch keine Tastatur läuft, die Befehle mit dem angesteckten
Tastatur-Cover eintippen.

## Weg A: Mit GitHub (empfohlen, einfaches Aktualisieren)

    cd ~
    git clone https://github.com/kruegertim/tiptab.git
    cd tiptab
    git checkout wip/next        # neueste Version mit Wörterbuch; für die stabile Version: main
    ./install.sh

Danach **einmal ab- und wieder anmelden** (unter Wayland lädt GNOME neue Erweiterungen nur beim
Anmelden) und dann einschalten:

    gnome-extensions enable tablet-osk@kruegertim

Ist das Repository privat, fragt `git clone` nach Benutzername und Token. Am einfachsten vorher
`sudo apt install gh && gh auth login` ausführen, oder Weg B nehmen.

### Aktualisieren

    cd ~/tiptab
    git pull
    ./install.sh

Dann ab- und wieder anmelden. Die Erweiterung bleibt eingeschaltet, Einstellungen und gelernte
Wörter bleiben erhalten. `install.sh` ersetzt den installierten Ordner vollständig, alte Dateien
bleiben also nicht liegen.

## Weg B: Mit dem Zip-Paket (ohne GitHub auf dem Tablet)

1. Auf dem Laptop (oder einem anderen Rechner mit dem Repository) das Paket bauen:

        cd ~/osk                 # bzw. dort, wo das Repository liegt
        packaging/build-zip.sh

   Ergebnis: `dist/tablet-osk@kruegertim.shell-extension.zip` (etwa 2 MB). Das Skript gibt am Ende
   eine SHA256-Prüfsumme aus.

2. Die Datei auf das Miix kopieren, zum Beispiel per USB-Stick oder über das Netz:

        scp dist/tablet-osk@kruegertim.shell-extension.zip tim@miix:~/

3. Auf dem Miix installieren:

        sha256sum ~/tablet-osk@kruegertim.shell-extension.zip   # optional: mit der Ausgabe vergleichen
        gnome-extensions install --force ~/tablet-osk@kruegertim.shell-extension.zip

4. Ab- und wieder anmelden, dann:

        gnome-extensions enable tablet-osk@kruegertim

Zum **Aktualisieren** einfach ein neues Zip bauen und die Schritte 2 bis 4 wiederholen
(`--force` überschreibt die alte Version; Schritt 4 entfällt, wenn sie schon eingeschaltet war).

Alternativ geht auch `./install.sh --zip` in einem geklonten Repository: Das baut das Zip und
installiert es in einem Schritt.

## Nach der ersten Installation

- In der oberen Leiste erscheint ein Tastatur-Symbol. Ein Tipp darauf blendet die Tastatur ein
  und aus.
- Das Zahnrad links in der Vorschlagsleiste öffnet die Einstellungen (Tastenhöhe, Angedockt oder
  Schwebend, F-Reihe, Layout, Vorschläge, Autokorrektur …). Dieselben Einstellungen gibt es im
  Programm „Erweiterungen“ oder mit `gnome-extensions prefs tablet-osk@kruegertim`.
- Die eingebaute GNOME-Bildschirmtastatur (Einstellungen › Barrierefreiheit) wird automatisch
  unterdrückt, solange die Erweiterung läuft. Sie muss nicht abgeschaltet werden.
- Danach die [Touch-Test-Checkliste](touch-test-checkliste.md) durchgehen.

## Entfernen

    cd ~/tiptab && ./install.sh --uninstall

oder ohne Repository:

    gnome-extensions disable tablet-osk@kruegertim
    gnome-extensions uninstall tablet-osk@kruegertim

Einstellungen und gelernte Wörter bleiben dabei erhalten. Um auch sie zu löschen:

    ./install.sh --uninstall --purge

oder von Hand:

    dconf reset -f /org/gnome/shell/extensions/tablet-osk/
    rm -rf ~/.local/share/tablet-osk          # gelerntes Wörterbuch

Danach einmal ab- und wieder anmelden.

## Wo liegt was?

| Was | Ort |
|---|---|
| Erweiterung | `~/.local/share/gnome-shell/extensions/tablet-osk@kruegertim/` |
| Einstellungen | dconf `/org/gnome/shell/extensions/tablet-osk/` |
| Gelernte Wörter | `~/.local/share/tablet-osk/userdict.json` (bleibt auf dem Gerät) |
| Protokoll | `journalctl --user -b \| grep tablet-osk` (bzw. `journalctl -b /usr/bin/gnome-shell`) |

## Wenn etwas nicht klappt

- **`gnome-extensions enable` meldet „Extension does not exist“:** Nach der Installation wurde
  noch nicht ab- und wieder angemeldet.
- **Erweiterung steht auf „Fehler“:** `gnome-extensions info tablet-osk@kruegertim` zeigt den
  Zustand, die Ursache steht im Protokoll:
  `journalctl -b /usr/bin/gnome-shell | grep -iA5 tablet-osk | tail -40`.
- **Gar keine Erweiterungen aktiv:** `gsettings get org.gnome.shell disable-user-extensions` muss
  `false` sein (sonst `gsettings set org.gnome.shell disable-user-extensions false`).
- **Tastatur erscheint nicht automatisch:** Bei angestecktem Tastatur-Cover ist das so gewollt.
  Im Protokoll steht bei jedem An- und Abstecken, welche Geräte als externe Tastatur zählen
  (Zeilen mit `[tablet-osk]`). Ein USB-Empfänger für eine Maus kann ebenfalls als Tastatur zählen.
  Zum Testen gibt es in den Einstellungen den Schalter „Physische Tastatur ignorieren“.
- **Dock bleibt links:** Die Tastatur schiebt das Ubuntu-Dock nach links, solange sie sichtbar ist,
  und stellt es danach zurück. Falls es nach einem Absturz links bleibt:
  `gsettings set org.gnome.shell.extensions.dash-to-dock dock-position BOTTOM`.
- **Tasten zu groß oder zu klein:** Die Tastenhöhe wird in Millimetern über die gemeldete
  Bildschirmgröße umgerechnet. Stimmt die Größe nicht, Tastenhöhe im Zahnrad-Menü anpassen.
