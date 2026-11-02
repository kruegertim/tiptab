# Touch-Test auf dem Miix 520

Zum Abhaken direkt auf dem Tablet. Bei jedem Punkt, der nicht passt, bitte kurz notieren, was
passiert ist. Am Ende das Protokoll sichern (siehe unten) und beides zurückmelden.

Datum: ____________  Version/Commit (`git -C ~/tiptab log -1 --oneline`): ____________

**Vorbereitung**
- [ ] Tastatur-Cover abgezogen, Erweiterung eingeschaltet, einmal neu angemeldet
- [ ] Einstellungen zurückgesetzt, damit alle mit den Standardwerten starten:
      `dconf reset -f /org/gnome/shell/extensions/tablet-osk/` (danach ab- und anmelden)
- [ ] Bildschirm im Querformat

## 1. Tastengröße und Trefferquote

- [ ] Bei Standardhöhe (11,5 mm) lassen sich Buchstaben mit dem Zeigefinger sicher treffen
- [ ] Ein Absatz Text (ca. 3 Sätze) im Texteditor: Anzahl Vertipper: ____
- [ ] Die Tastatur nimmt nicht zu viel Platz weg (geschätzter Anteil der Bildschirmhöhe: ____ %)
- [ ] Im Zahnrad-Menü Tastenhöhe auf 9 mm und 14 mm stellen: Änderung sofort sichtbar,
      Beschriftung bleibt lesbar. Angenehmste Höhe: ____ mm
- [ ] F-Reihe aus (Kompakt): Fn + 1 … ´ ergibt F1 … F12
- [ ] Pfeiltasten, Pos1/Ende, Bild↑/Bild↓, Entf funktionieren im Texteditor
- [ ] Rücktaste gedrückt halten: löscht nach ca. ½ Sekunde fortlaufend
- [ ] Taste angetippt, Finger auf die Nachbartaste gerutscht und losgelassen: es kommt die
      zuerst berührte Taste

## 2. Wischen

- [ ] Auf den Tasten nach unten wischen (gut eine Tastenhöhe): Tastatur verschwindet,
      **kein** Zeichen wird getippt
- [ ] Kurzes Zittern oder seitliches Verrutschen beim Tippen löst **kein** Ausblenden aus
- [ ] Vom unteren Bildschirmrand nach oben wischen: Tastatur erscheint
- [ ] Wischen vom unteren Rand stört das Ubuntu-Dock bzw. die Übersicht nicht
- [ ] Symbol in der oberen Leiste: blendet ein und aus
- [ ] Taste mit Tastatur-Symbol (unten rechts): blendet aus

## 3. Umschalttasten

- [ ] Shift einmal antippen: nächster Buchstabe groß, danach wieder klein
- [ ] Shift zweimal schnell: Feststellen (sichtbar markiert), nochmal antippen hebt auf
- [ ] Shift **halten** (länger als 1 s) und mit zweitem Finger mehrere Buchstaben tippen: alle
      groß; nach dem Loslassen wieder klein
- [ ] Strg antippen, dann C bzw. V: Kopieren/Einfügen klappt
- [ ] Strg halten + A: alles markieren
- [ ] AltGr + Q ergibt @, AltGr + E ergibt €
- [ ] Super-Taste (Fisch) antippen: öffnet die Übersicht; zweimal antippen: App-Raster
- [ ] Haltedauer im Zahnrad-Menü geändert: Verhalten passt sich an (gewählter Wert: ____ ms)

## 4. Automatisches Ein- und Ausblenden (ohne Tastatur-Cover)

- [ ] Texteditor: in das Textfeld tippen → Tastatur erscheint
- [ ] Firefox: Adressleiste antippen → erscheint; ein Suchfeld auf einer Webseite → erscheint
- [ ] Einstellungen-Programm, Suchfeld → erscheint
- [ ] GNOME-Übersicht (Suche) → erscheint
- [ ] Passwortfeld (z. B. Passwortabfrage beim Installieren von Software): erscheint, **keine**
      Vorschläge in der Leiste
- [ ] Bildschirmsperre: Dort laufen keine Erweiterungen, es erscheint GNOMEs eigene Tastatur
      (nur zur Info, kein Fehler). Kommt sie überhaupt? ja / nein
- [ ] Antippen von etwas, das kein Textfeld ist: Tastatur verschwindet
- [ ] Wechsel zwischen zwei Textfeldern mit Tab: Tastatur bleibt, kein Flackern
- [ ] Nachricht/Suchfeld mit Enter abschicken: automatisch eingeblendete Tastatur verschwindet
- [ ] Fenster bleiben bei sichtbarer Tastatur vollständig bedienbar (Inhalt rückt nach oben,
      Eingabefeld nicht verdeckt)
- [ ] Ubuntu-Dock wandert nach links, solange die Tastatur sichtbar ist, und danach zurück

## 5. Tastatur-Cover an- und abstecken

- [ ] Cover anstecken, während die Tastatur sichtbar ist: was passiert? ____________
- [ ] Mit angestecktem Cover in ein Textfeld tippen: Tastatur erscheint **nicht** automatisch
- [ ] Mit angestecktem Cover: Symbol in der oberen Leiste blendet trotzdem ein
- [ ] Cover abziehen, in ein Textfeld tippen: Tastatur erscheint wieder automatisch
- [ ] Cover nach hinten geklappt (Tablet-Stellung, falls möglich): zählt es noch als Tastatur? ____
- [ ] Bluetooth- oder USB-Tastatur angeschlossen: wie Cover

## 6. Vorschläge und Autokorrektur

- [ ] Beim Tippen erscheinen 3 Vorschläge, Antippen ersetzt das Wort
- [ ] Ein Tippfehler (z. B. „Hsus “) wird beim Leerzeichen korrigiert
- [ ] Rücktaste direkt danach stellt das ursprüngliche Wort wieder her
- [ ] Englisch: Layout auf QWERTY → englische Vorschläge
- [ ] Spürbare Verzögerung beim Tippen? ja / nein

## 7. Schwebend-Modus

- [ ] Im Zahnrad-Menü auf „Schwebend“: Tastatur wird kleiner und frei verschiebbar
- [ ] An der Griffleiste verschieben, an der Ecke unten rechts Größe ändern
- [ ] Deckkraft-Regler wirkt
- [ ] Nach Ab- und Anmelden: Position und Größe bleiben erhalten

## 8. Drehen und Sonstiges

- [ ] Bildschirm ins Hochformat drehen: Tastatur passt sich der Breite an
- [ ] Zurück ins Querformat: wieder richtig
- [ ] Bildschirmsperre und Aufwachen aus dem Standby: Tastatur funktioniert danach noch
- [ ] Stift (falls vorhanden) tippt wie ein Finger

## Protokoll sichern

    journalctl --user -b | grep tablet-osk > ~/tablet-osk-test.log
    journalctl -b /usr/bin/gnome-shell | grep -iA5 tablet-osk >> ~/tablet-osk-test.log

Die Datei `~/tablet-osk-test.log` enthält auch die Liste der erkannten Eingabegeräte (wichtig für
Punkt 5). Notizen:

____________________________________________________________________________

____________________________________________________________________________
