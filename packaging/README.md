# Paket bauen

    packaging/build-zip.sh            # -> dist/tablet-osk@kruegertim.shell-extension.zip
    packaging/build-zip.sh --out /tmp # anderer Zielordner

Das Zip hat dasselbe Format wie `gnome-extensions pack` und lässt sich mit
`gnome-extensions install --force <zip>` installieren (Anleitung: `docs/installation-miix.md`).

Was das Skript macht:

1. Kopiert nur die Laufzeitdateien aus `tablet-osk@kruegertim/` (JavaScript, CSS, Symbole,
   `metadata.json`, Schema, Wörterbücher `predict/data/*.json`). `predict/package.json`, Tests und
   `tools/` bleiben draußen.
2. Legt `LICENSE` (GPL-3.0) und die Quellenangaben der Wörterbücher (`tools/DATA_LICENSES.md` als
   `predict/data/LICENSES.md`, nötig wegen CC-BY-SA) mit ins Paket.
3. Prüft `metadata.json` und die Wörterbuch-JSONs, kompiliert das Schema mit
   `glib-compile-schemas --strict` (`schemas/gschemas.compiled` liegt im Zip).
4. Packt mit fester Dateireihenfolge und festen Zeitstempeln (Zeit des letzten Commits oder
   `SOURCE_DATE_EPOCH`). Derselbe Commit ergibt dasselbe Zip mit derselben SHA256-Prüfsumme.

Benötigt: `bash`, `glib-compile-schemas` (Paket `libglib2.0-bin`), `zip`, `python3`.
Ein GNOME-Desktop ist zum Bauen nicht nötig.

Die Wörterbücher selbst werden nicht hier gebaut, sondern mit `tools/build_predict_data.sh`
erzeugt und liegen fertig im Repository.
