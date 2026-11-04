#!/usr/bin/env python3
"""Build the prediction data files for tablet-osk (predict/data/<lang>.json).

Python 3, standard library only.  Not shipped with the extension.

Inputs (all local files; see tools/DATA_LICENSES.md for where they come from):
  --freq       word frequency list "word count" per line, most frequent first
               (hermitdave FrequencyWords, OpenSubtitles 2018, CC-BY-SA 4.0)
  --dict       one or more plain word lists (one word per line, correct case),
               e.g. /usr/share/dict/ngerman or /usr/share/dict/american-english
  --hunspell   optional hunspell .dic files; only the stems (before '/') are
               used, as additional "valid word" evidence for the bloom filter
  --sentences  optional Tatoeba per-language export (id<TAB>lang<TAB>text),
               plain or .bz2.  Used for (a) bigram counts, (b) sentence-start
               distribution, (c) deciding canonical capitalisation and
               (d) English contractions (the subtitle list splits "don't").

Output: compact JSON, see predict/loader.js for the format.

Example:
  python3 -I tools/build_predict_data.py --lang de \
     --freq dl/de_300k.txt --dict /usr/share/dict/ngerman \
     --hunspell /usr/share/hunspell/de_DE.dic \
     --sentences dl/deu_sentences.tsv.bz2 \
     --out tablet-osk@kruegertim/predict/data/de.json
"""

import argparse
import base64
import bz2
import collections
import json
import math
import re
import sys

FORMAT_VERSION = 1

# Letters we accept inside words (Latin + German umlauts + common accents).
WORD_CHARS = "a-zA-ZäöüÄÖÜßéèêàâçñóôíúÉ"
TOKEN_RE = {
    "de": re.compile(r"[%s]+(?:-[%s]+)*" % (WORD_CHARS, WORD_CHARS)),
    "en": re.compile(r"[%s]+(?:'[%s]+)?" % (WORD_CHARS, WORD_CHARS)),
}
VALID_WORD_RE = re.compile(r"^[%s][%s'\-]*$" % (WORD_CHARS, WORD_CHARS))

# English: the subtitle list tokenises "don't" as "don" + "t"; drop the fragments.
EN_FRAGMENTS = {
    "t", "s", "ll", "re", "ve", "m", "d", "don", "didn", "doesn", "isn", "wasn",
    "couldn", "wouldn", "shouldn", "aren", "weren", "hasn", "haven", "hadn",
    "mustn", "needn", "ain", "o",
}
EN_CONTRACTION_SUFFIX = ("n't", "'m", "'re", "'ve", "'ll", "'d")
EN_S_CONTRACTIONS = {
    "it's", "that's", "he's", "she's", "what's", "there's", "let's", "here's",
    "who's", "where's", "how's", "when's", "why's", "everyone's", "everybody's",
    "nobody's", "somebody's", "someone's", "something's", "nothing's",
    "everything's", "today's", "one's",
}
# Tatoeba's example sentences are dominated by a few stock names ("Tom ist ...");
# keep them out of the bigram/sentence-start tables so they are not predicted.
TATOEBA_NAMES = {"tom", "mary", "maria", "john", "toms", "marys", "marias", "johns", "tom's", "mary's"}
# Single-letter words that are allowed in the lexicon.
SINGLE_LETTERS = {"de": set(), "en": {"a", "i"}}


def open_text(path):
    if path.endswith(".bz2"):
        return bz2.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, encoding="utf-8", errors="replace")


def read_dict(paths, hunspell_paths):
    """Return (forms_by_lower, valid_lower_set)."""
    forms = collections.defaultdict(set)
    for p in paths:
        with open_text(p) as f:
            for line in f:
                w = line.strip()
                if w and not w.startswith("#"):
                    forms[w.lower()].add(w)
    valid = set(forms)
    for p in hunspell_paths:
        with open_text(p) as f:
            first = True
            for line in f:
                if first:          # first line = entry count
                    first = False
                    continue
                if line.startswith(("#", "\t", " ")):
                    continue
                w = line.split("/", 1)[0].strip()
                if w and VALID_WORD_RE.match(w):
                    valid.add(w.lower())
    return forms, valid


def read_sentences(path, lang):
    """Tokenise Tatoeba sentences.

    Returns (unigram_lower, case_counts_mid, bigram_counts, start_counts).
    case_counts_mid[lower][form] counts forms seen NOT at sentence start.
    """
    tok_re = TOKEN_RE[lang]
    uni = collections.Counter()
    case_mid = collections.defaultdict(collections.Counter)
    bi = collections.Counter()
    start = collections.Counter()
    n = 0
    with open_text(path) as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            text = parts[2].replace("’", "'").replace("`", "'")
            # split into clauses at sentence punctuation so bigrams don't
            # cross sentence boundaries
            for clause in re.split(r"[.!?;:]+", text):
                toks = tok_re.findall(clause)
                if not toks:
                    continue
                prev = None
                for i, t in enumerate(toks):
                    lo = t.lower()
                    uni[lo] += 1
                    if i > 0:
                        case_mid[lo][t] += 1
                    if prev is None:
                        start[lo] += 1
                    else:
                        bi[(prev, lo)] += 1
                    prev = lo
            n += 1
    print("  sentences: %d, tokens: %d, bigram types: %d" % (n, sum(uni.values()), len(bi)),
          file=sys.stderr)
    return uni, case_mid, bi, start


def canonical_form(lower, forms, case_mid):
    """Pick the stored spelling.

    Lowercase when the dictionary has a lowercase form and it is actually used
    lowercase mid-sentence (or we have no evidence); otherwise the dictionary's
    capitalised/mixed form (German nouns, 'I', names, acronyms)."""
    fs = forms.get(lower, set())
    mid = case_mid.get(lower, collections.Counter())
    if lower in fs:
        lc = mid.get(lower, 0)
        other = sum(c for f, c in mid.items() if f != lower)
        if lc == 0 and other >= 20:
            pass  # e.g. English "i": dictionary lists it, but nobody writes it
        elif other > 0 and lc * 20 < other and other >= 20:
            pass
        else:
            return lower
    candidates = [f for f in fs if f != lower] or list(mid.keys()) or [lower]
    # most frequent mid-sentence spelling, else Capitalised before ALLCAPS
    candidates.sort(key=lambda f: (-mid.get(f, 0), f.isupper(), f))
    return candidates[0]


class Bloom:
    """Bloom filter; hashing must match predict/loader.js (FNV-1a + double hashing)."""

    def __init__(self, n, fp):
        m = int(math.ceil(-n * math.log(fp) / (math.log(2) ** 2)))
        m = (m + 7) // 8 * 8
        self.m = m
        self.k = max(1, int(round(m / n * math.log(2))))
        self.bits = bytearray(m // 8)

    @staticmethod
    def _hashes(s):
        h1 = 0x811C9DC5
        h2 = 0x01000193 ^ 0x5BD1E995
        for ch in s:
            c = ord(ch)
            units = [c] if c < 0x10000 else [0xD800 + ((c - 0x10000) >> 10), 0xDC00 + ((c - 0x10000) & 0x3FF)]
            for u in units:
                h1 ^= u
                h1 = (h1 * 0x01000193) & 0xFFFFFFFF
                h2 ^= u
                h2 = (h2 * 0x5BD1E995) & 0xFFFFFFFF
                h2 ^= h2 >> 15
        h2 |= 1
        return h1, h2

    def add(self, s):
        h1, h2 = self._hashes(s)
        for i in range(self.k):
            b = (h1 + i * h2) % self.m
            self.bits[b >> 3] |= 1 << (b & 7)

    def to_json(self):
        return {"m": self.m, "k": self.k, "b": base64.b64encode(bytes(self.bits)).decode("ascii")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", required=True, choices=["de", "en"])
    ap.add_argument("--freq", required=True)
    ap.add_argument("--dict", nargs="+", required=True)
    ap.add_argument("--hunspell", nargs="*", default=[])
    ap.add_argument("--sentences")
    ap.add_argument("--size", type=int, default=50000, help="number of lexicon words")
    ap.add_argument("--bigram-prev", type=int, default=6000, help="max number of context words")
    ap.add_argument("--bigram-next", type=int, default=10, help="max successors per context word")
    ap.add_argument("--bigram-min", type=int, default=3, help="minimum bigram count")
    ap.add_argument("--bloom-fp", type=float, default=0.005)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    lang = a.lang

    print("[%s] reading dictionaries" % lang, file=sys.stderr)
    forms, valid = read_dict(a.dict, a.hunspell)
    print("  dictionary forms: %d, valid lower-case set: %d" % (len(forms), len(valid)), file=sys.stderr)

    if a.sentences:
        print("[%s] reading sentences" % lang, file=sys.stderr)
        t_uni, case_mid, t_bi, t_start = read_sentences(a.sentences, lang)
    else:
        t_uni, case_mid, t_bi, t_start = collections.Counter(), {}, collections.Counter(), collections.Counter()

    print("[%s] filtering frequency list" % lang, file=sys.stderr)
    counts = collections.OrderedDict()
    dropped = 0
    with open_text(a.freq) as f:
        for line in f:
            parts = line.split()
            if len(parts) != 2:
                continue
            w, c = parts[0].lower(), int(parts[1])
            if not VALID_WORD_RE.match(w) or w.endswith(("-", "'")):
                dropped += 1
                continue
            if lang == "en" and w in EN_FRAGMENTS:
                continue
            if len(w) == 1 and w not in SINGLE_LETTERS[lang]:
                continue
            if w not in forms:      # subtitle junk, names, typos, foreign words
                dropped += 1
                continue
            if w in counts:
                continue
            counts[w] = c
            if len(counts) >= a.size:
                break
    print("  kept %d, dropped %d" % (len(counts), dropped), file=sys.stderr)

    if lang == "en" and t_uni:
        # Add contractions using Tatoeba counts scaled to the subtitle scale.
        common = [w for w in list(counts)[:2000] if t_uni.get(w, 0) >= 20]
        ratios = sorted(counts[w] / t_uni[w] for w in common)
        scale = ratios[len(ratios) // 2] if ratios else 1.0
        added = 0
        for w, c in t_uni.most_common():
            if c < 5:
                break
            if "'" not in w or w in counts or w not in forms:
                continue
            if not (w.endswith(EN_CONTRACTION_SUFFIX) or w in EN_S_CONTRACTIONS):
                continue
            counts[w] = int(c * scale)
            added += 1
        print("  added %d contractions (scale %.1f)" % (added, scale), file=sys.stderr)
        if "won't" in counts and "won" in counts:   # "won" is inflated by "won't"
            counts["won"] = max(counts["won"] // 4, counts["won"] - counts["won't"])

    lex = {w: canonical_form(w, forms, case_mid) for w in counts}
    keys = sorted(lex)            # code point order == JS UTF-16 order for BMP
    qf = []
    for k in keys:
        qf.append(max(1, int(round(math.log(counts[k]) * 16))))

    # ---- bigrams --------------------------------------------------------
    succ = collections.defaultdict(list)
    for (p, n), c in t_bi.items():
        if c >= a.bigram_min and p in lex and n in lex and n not in TATOEBA_NAMES and p not in TATOEBA_NAMES:
            succ[p].append((c, n))
    totals = collections.Counter()
    for (p, n), c in t_bi.items():
        totals[p] += c
    prevs = sorted(succ, key=lambda p: -totals[p])[: a.bigram_prev]
    bigrams = {}
    for p in prevs:
        lst = sorted(succ[p], key=lambda x: (-x[0], x[1]))[: a.bigram_next]
        flat = [totals[p]]
        for c, n in lst:
            flat.extend([n, c])
        bigrams[p] = flat
    starts = [(c, w) for w, c in t_start.items()
              if w in lex and c >= a.bigram_min and w not in TATOEBA_NAMES]
    starts.sort(key=lambda x: (-x[0], x[1]))
    if starts:
        flat = [sum(t_start.values())]
        for c, w in starts[: a.bigram_next * 2]:
            flat.extend([w, c])
        bigrams["<s>"] = flat
    print("  bigram contexts: %d" % len(bigrams), file=sys.stderr)

    # ---- bloom filter of all valid words (protects rare valid words) -----
    allvalid = set(valid) | set(lex)
    bloom = Bloom(len(allvalid), a.bloom_fp)
    for w in allvalid:
        bloom.add(w)

    out = {
        "v": FORMAT_VERSION,
        "lang": lang,
        "n": len(keys),
        # canonical spellings, sorted by lower-case key (code unit order)
        "words": [lex[k] for k in keys],
        # round(16*ln(count)) per word, parallel to "words"
        "f": qf,
        # context(lower) -> [total, next1, count1, next2, count2, ...]; "<s>" = sentence start
        "bigrams": bigrams,
        "bloom": bloom.to_json(),
        "sources": "OpenSubtitles2018 frequencies via hermitdave/FrequencyWords (CC-BY-SA 4.0); "
                   "word lists: Debian wngerman/wamerican, hunspell; bigrams: Tatoeba (CC-BY 2.0 FR)",
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("[%s] wrote %s (%d words)" % (lang, a.out, len(keys)), file=sys.stderr)


if __name__ == "__main__":
    main()
