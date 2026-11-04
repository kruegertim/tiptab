#!/bin/sh
# Download the public source lists (into a scratch dir) and rebuild
# tablet-osk@kruegertim/predict/data/{de,en}.json.  Needs curl, python3, bzip2 support in python.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../tablet-osk@kruegertim/predict/data"
dl=${DL_DIR:-$(mktemp -d)}
fw=https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018
for l in de en; do
    [ -s "$dl/${l}_300k.txt" ] || curl -sSfL "$fw/$l/${l}_full.txt" | head -300000 > "$dl/${l}_300k.txt" || true
done
[ -s "$dl/deu_sentences.tsv.bz2" ] || curl -sSfL -o "$dl/deu_sentences.tsv.bz2" https://downloads.tatoeba.org/exports/per_language/deu/deu_sentences.tsv.bz2
[ -s "$dl/eng_sentences.tsv.bz2" ] || curl -sSfL -o "$dl/eng_sentences.tsv.bz2" https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2
mkdir -p "$out"
python3 -I "$here/build_predict_data.py" --lang de --freq "$dl/de_300k.txt" \
    --dict /usr/share/dict/ngerman --hunspell /usr/share/hunspell/de_DE.dic \
    --sentences "$dl/deu_sentences.tsv.bz2" --out "$out/de.json"
python3 -I "$here/build_predict_data.py" --lang en --freq "$dl/en_300k.txt" \
    --dict /usr/share/dict/american-english --hunspell /usr/share/hunspell/en_US.dic \
    --sentences "$dl/eng_sentences.tsv.bz2" --out "$out/en.json"
ls -l "$out"
