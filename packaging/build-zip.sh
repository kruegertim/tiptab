#!/bin/bash
# Baut das installierbare Erweiterungs-Zip (gleiches Format wie `gnome-extensions pack`).
#
#   packaging/build-zip.sh [--out VERZEICHNIS]
#
# Ergebnis: dist/tablet-osk@kruegertim.shell-extension.zip
# Installieren: gnome-extensions install --force dist/tablet-osk@kruegertim.shell-extension.zip
#
# Reproduzierbar: feste Dateireihenfolge, feste Zeitstempel (Commit-Zeit bzw.
# SOURCE_DATE_EPOCH), keine Extra-Attribute. Gleicher Commit => gleiche Prüfsumme.
# Benötigt nur: bash, glib-compile-schemas (libglib2.0-bin), zip, python3.
set -euo pipefail

UUID=tablet-osk@kruegertim
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/$UUID"
OUT="$ROOT/dist"

while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT="$2"; shift 2 ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    esac
done

for tool in glib-compile-schemas zip python3; do
    command -v "$tool" >/dev/null || { echo "Fehlt: $tool (sudo apt install libglib2.0-bin zip python3)" >&2; exit 1; }
done

# Zeitstempel für alle Dateien im Zip
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
    SOURCE_DATE_EPOCH=$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 315532800)
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/$UUID"
mkdir -p "$PKG"

# 1. Dateien, die GNOME Shell zur Laufzeit braucht (Tests, Build-Werkzeuge,
#    package.json für node usw. bleiben draußen).
( cd "$SRC" && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.png' \
      -o -name 'metadata.json' -o -name '*.gschema.xml' -o -path './predict/data/*.json' \) \
      -print ) | LC_ALL=C sort | while read -r f; do
    mkdir -p "$PKG/$(dirname "$f")"
    cp "$SRC/$f" "$PKG/$f"
done

# Lizenzen und Quellenangaben gehören mit ins Paket (CC-BY-SA verlangt die Namensnennung).
cp "$ROOT/LICENSE" "$PKG/LICENSE"
cp "$ROOT/tools/DATA_LICENSES.md" "$PKG/predict/data/LICENSES.md"

# 2. Prüfungen
python3 - "$PKG" <<'PY'
import json, sys, pathlib
pkg = pathlib.Path(sys.argv[1])
meta = json.loads((pkg / "metadata.json").read_text())
for k in ("uuid", "name", "description", "shell-version"):
    assert k in meta, f"metadata.json: '{k}' fehlt"
assert meta["uuid"] == pkg.name, "metadata.json: uuid passt nicht zum Ordnernamen"
for f in sorted((pkg / "predict" / "data").glob("*.json")):
    json.loads(f.read_text(encoding="utf-8"))
for req in ("extension.js", "prefs.js", "stylesheet.css"):
    assert (pkg / req).is_file(), f"{req} fehlt"
print(f"metadata ok: {meta['name']} v{meta.get('version')}, Shell {', '.join(meta['shell-version'])}")
PY
glib-compile-schemas --strict "$PKG/schemas"

# 3. Zip mit festen Zeitstempeln und fester Reihenfolge
find "$PKG" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
mkdir -p "$OUT"
ZIP="$(cd "$OUT" && pwd)/$UUID.shell-extension.zip"
rm -f "$ZIP"
( cd "$PKG" && find . -type f | LC_ALL=C sort | sed 's|^\./||' | TZ=UTC zip -q -X -9 "$ZIP" -@ )

echo "Gebaut: $ZIP ($(du -h "$ZIP" | cut -f1), $(unzip -Z1 "$ZIP" | wc -l) Dateien)"
echo "SHA256: $(sha256sum "$ZIP" | cut -d' ' -f1)"
