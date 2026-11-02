#!/bin/sh
# Download the public source lists (into a scratch dir) and rebuild
# tablet-osk@kruegertim/predict/data/{de,en}.json.  Needs curl and python3.
# Word lists: apt install wngerman wamerican hunspell-de-de hunspell-en-us
#
# Bigram corpora (mixed per context word with the weights below):
#   Tatoeba (conversational, weight 3)  – if downloads.tatoeba.org is not reachable, the
#       Tatoeba-only bigram table of the last v1 data files (git revision $SEED_REV) is used
#       instead (SEED=1 forces that);
#   Common Voice sentence-collector (weight 2) and Wikipedia sentences (weight 1), CC0.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../tablet-osk@kruegertim/predict/data"
dl=${DL_DIR:-$(mktemp -d)}
SEED_REV=${SEED_REV:-7aab6b2}
fw=https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018
cv=https://raw.githubusercontent.com/common-voice/common-voice/main/server/data
for l in de en; do
    [ -s "$dl/${l}_300k.txt" ] || curl -sSfL "$fw/$l/${l}_full.txt" | head -300000 > "$dl/${l}_300k.txt" || true
    [ -s "$dl/cv_${l}_sentence-collector.txt" ] || curl -sSfL -o "$dl/cv_${l}_sentence-collector.txt" "$cv/$l/sentence-collector.txt"
    [ -s "$dl/cv_${l}_wiki.txt" ] || curl -sSfL -o "$dl/cv_${l}_wiki.txt" "$cv/$l/wiki.$l.txt"
done
if [ "${SEED:-0}" != 1 ]; then
    [ -s "$dl/deu_sentences.tsv.bz2" ] || curl -sSfL -o "$dl/deu_sentences.tsv.bz2" https://downloads.tatoeba.org/exports/per_language/deu/deu_sentences.tsv.bz2 || rm -f "$dl/deu_sentences.tsv.bz2"
    [ -s "$dl/eng_sentences.tsv.bz2" ] || curl -sSfL -o "$dl/eng_sentences.tsv.bz2" https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2 || rm -f "$dl/eng_sentences.tsv.bz2"
fi
mkdir -p "$out"
build() { # lang tatoeba-file dict hunspell
    l=$1
    if [ -s "$dl/$2" ]; then
        conv="$dl/$2=3"; seed=""
    else
        # no Tatoeba: use the Tatoeba bigrams (and case decisions) of the last v1 build
        git -C "$here" show "$SEED_REV:tablet-osk@kruegertim/predict/data/$l.json" > "$dl/seed_$l.json"
        conv=""; seed="--seed-bigrams $dl/seed_$l.json=3"
    fi
    # shellcheck disable=SC2086
    python3 -I "$here/build_predict_data.py" --lang "$l" --freq "$dl/${l}_300k.txt" \
        --dict "$3" --hunspell "$4" \
        --sentences $conv "$dl/cv_${l}_sentence-collector.txt=2" "$dl/cv_${l}_wiki.txt=1" \
        $seed --out "$out/$l.json"
}
build de deu_sentences.tsv.bz2 /usr/share/dict/ngerman /usr/share/hunspell/de_DE.dic
build en eng_sentences.tsv.bz2 /usr/share/dict/american-english /usr/share/hunspell/en_US.dic
ls -l "$out"
