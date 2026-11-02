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
  --sentences  optional sentence corpora, repeatable, each PATH or PATH=WEIGHT.
               Either a Tatoeba per-language export (id<TAB>lang<TAB>text) or a
               plain text file with one sentence per line (Mozilla Common Voice
               sentence lists), plain or .bz2.  Used for (a) bigram counts,
               (b) sentence-start distribution, (c) deciding canonical
               capitalisation and (d) English contractions (the subtitle list
               splits "don't").  Each corpus gives P(next | word); the corpora
               are mixed with their weights (default 1) per context word, so a
               huge encyclopedic corpus cannot drown a small conversational one.
  --seed-bigrams  optional PATH=WEIGHT of an existing predict/data/<lang>.json
               whose bigram table is mixed in like a corpus (lets the data be
               rebuilt where the Tatoeba download is not reachable).

Output: compact JSON (format v2), see predict/loader.js for the format.

Example:
  python3 -I tools/build_predict_data.py --lang de \
     --freq dl/de_300k.txt --dict /usr/share/dict/ngerman \
     --hunspell /usr/share/hunspell/de_DE.dic \
     --sentences dl/deu_sentences.tsv.bz2=3 dl/cv_de_sentence-collector.txt=2 dl/cv_de_wiki.de.txt=1 \
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

FORMAT_VERSION = 2

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


def iter_sentences(path):
    """Yield sentence strings from a Tatoeba TSV export or a one-sentence-per-line file."""
    with open_text(path) as f:
        for line in f:
            line = line.rstrip("\n")
            parts = line.split("\t")
            if len(parts) >= 3 and parts[0].isdigit():
                yield parts[2]
            elif len(parts) == 1:
                yield line


def read_sentences(path, lang, case_mid, uni):
    """Tokenise one corpus.

    Adds to uni (lower-case unigram counts) and case_mid (case_mid[lower][form]
    counts forms seen NOT at sentence start, i.e. capitalisation evidence).
    Returns (bigram_counts, start_counts) of this corpus."""
    tok_re = TOKEN_RE[lang]
    bi = collections.Counter()
    start = collections.Counter()
    n = ntok = 0
    for text in iter_sentences(path):
        text = text.replace("’", "'").replace("`", "'")
        # split into clauses at sentence punctuation so bigrams don't
        # cross sentence boundaries
        for ci, clause in enumerate(re.split(r"[.!?;:]+", text)):
            toks = tok_re.findall(clause)
            if not toks:
                continue
            prev = None
            # only the first clause and clauses after . ! ? really start a sentence;
            # treat every clause start as "start" for bigrams (no cross-clause pairs)
            for i, t in enumerate(toks):
                lo = t.lower()
                uni[lo] += 1
                ntok += 1
                if i > 0:
                    case_mid[lo][t] += 1
                if prev is None:
                    start[lo] += 1
                else:
                    bi[(prev, lo)] += 1
                prev = lo
        n += 1
    print("  %s: sentences: %d, tokens: %d, bigram types: %d" % (path, n, ntok, len(bi)),
          file=sys.stderr)
    return bi, start


def read_seed_bigrams(path):
    """Bigram table of an existing data file (v1: successor words, v2: indices)."""
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    words = [w.lower() for w in d["words"]]
    bi = collections.Counter()
    start = collections.Counter()
    for ctx, e in d.get("bigrams", {}).items():
        total = e[0]
        rest = 0
        for j in range(1, len(e), 2):
            nxt = e[j] if isinstance(e[j], str) else words[e[j]]
            c = e[j + 1]
            rest += c
            if ctx == "<s>":
                start[nxt] += c
            else:
                bi[(ctx, nxt)] += c
        # keep the context's total mass (the unlisted tail) under a dummy successor
        if total > rest:
            if ctx == "<s>":
                start[None] += total - rest
            else:
                bi[(ctx, None)] += total - rest
    print("  seed %s: bigram pairs %d" % (path, len(bi)), file=sys.stderr)
    return bi, start


def split_weight(spec):
    if "=" in spec:
        p, w = spec.rsplit("=", 1)
        try:
            return p, float(w)
        except ValueError:
            pass
    return spec, 1.0


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
    ap.add_argument("--sentences", nargs="*", default=[], help="corpora PATH[=WEIGHT]")
    ap.add_argument("--seed-bigrams", nargs="*", default=[], help="old data file PATH[=WEIGHT]")
    ap.add_argument("--size", type=int, default=50000, help="number of lexicon words")
    ap.add_argument("--bigram-prev", type=int, default=12000, help="max number of context words")
    ap.add_argument("--bigram-next", type=int, default=12, help="max successors per context word")
    ap.add_argument("--bigram-min", type=int, default=3, help="minimum bigram count (in one corpus)")
    ap.add_argument("--bigram-minp", type=float, default=0.004, help="minimum P(next|word) to keep")
    ap.add_argument("--bigram-scale", type=int, default=2000, help="stored total per context")
    ap.add_argument("--bloom-fp", type=float, default=0.005)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    lang = a.lang

    print("[%s] reading dictionaries" % lang, file=sys.stderr)
    forms, valid = read_dict(a.dict, a.hunspell)
    print("  dictionary forms: %d, valid lower-case set: %d" % (len(forms), len(valid)), file=sys.stderr)

    case_mid = collections.defaultdict(collections.Counter)
    t_uni = collections.Counter()
    corpora = []        # (weight, bigram Counter, start Counter, name)
    for spec in a.sentences:
        path, w = split_weight(spec)
        print("[%s] reading sentences %s (weight %g)" % (lang, path, w), file=sys.stderr)
        bi, st = read_sentences(path, lang, case_mid, t_uni)
        corpora.append((w, bi, st, path))
    seed_counts = {}
    seed_forms = {}     # canonical spellings chosen by an earlier build
    for spec in a.seed_bigrams:
        path, w = split_weight(spec)
        print("[%s] reading seed bigrams %s (weight %g)" % (lang, path, w), file=sys.stderr)
        bi, st = read_seed_bigrams(path)
        corpora.append((w, bi, st, path))
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        for word, q in zip(d["words"], d["f"]):
            seed_counts.setdefault(word.lower(), int(round(math.exp(q / 16))))
            seed_forms.setdefault(word.lower(), word)

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

    if lang == "en":
        # The subtitle list splits contractions; add them back.  Counts come from the
        # sentence corpora scaled to the subtitle scale, else from a seed data file.
        added = 0
        common = [w for w in list(counts)[:2000] if t_uni.get(w, 0) >= 20]
        ratios = sorted(counts[w] / t_uni[w] for w in common)
        scale = ratios[len(ratios) // 2] if ratios else 1.0
        cand = {}
        for w, c in t_uni.items():
            if c >= 20 and "'" in w:
                cand[w] = int(c * scale)
        for w, c in seed_counts.items():
            if "'" in w:
                cand[w] = max(cand.get(w, 0), c)
        for w, c in sorted(cand.items(), key=lambda x: -x[1]):
            if w in counts or w not in forms:
                continue
            if not (w.endswith(EN_CONTRACTION_SUFFIX) or w in EN_S_CONTRACTIONS):
                continue
            counts[w] = c
            added += 1
        print("  added %d contractions (scale %.1f)" % (added, scale), file=sys.stderr)
        if "won't" in counts and "won" in counts:   # "won" is inflated by "won't"
            counts["won"] = max(counts["won"] // 4, counts["won"] - counts["won't"])

    def canon(w):
        # keep an earlier build's decision (it may have had more conversational case
        # evidence, e.g. Tatoeba)
        f = seed_forms.get(w)
        if f is not None:
            return f
        return canonical_form(w, forms, case_mid)

    lex = {w: canon(w) for w in counts}
    keys = sorted(lex)            # code point order == JS UTF-16 order for BMP
    index = {k: i for i, k in enumerate(keys)}
    qf = [max(1, int(round(math.log(counts[k]) * 16))) for k in keys]

    # Capitalised canonical spellings whose lower-case form is also a real word
    # ("Essen"/"essen", "May"/"may"): the engine must not force their case.
    amb = []
    for i, k in enumerate(keys):
        w = lex[k]
        if w == k:
            continue
        mid = case_mid.get(k, collections.Counter())
        lc, tot = mid.get(k, 0), sum(mid.values())
        if k in forms.get(k, ()) or (lc >= 3 and lc * 20 >= tot):
            amb.append(i)
    print("  capitalised words: %d, of which case-ambiguous: %d" %
          (sum(1 for k in keys if lex[k] != k), len(amb)), file=sys.stderr)

    # ---- bigrams: per-corpus P(next|word), mixed with corpus weights ------
    per_corpus = []     # (weight, {ctx: {next: count}}, {ctx: total})
    for w, bi, st, name in corpora:
        succ = collections.defaultdict(dict)
        tot = collections.Counter()
        for (p, n), c in bi.items():
            if p not in index:
                continue
            tot[p] += c
            if n is not None and n in index and c >= a.bigram_min and \
                    n not in TATOEBA_NAMES and p not in TATOEBA_NAMES:
                succ[p][n] = c
        stot = sum(st.values())
        if stot:
            tot["<s>"] = stot
            succ["<s>"] = {n: c for n, c in st.items()
                           if n is not None and n in index and c >= a.bigram_min and n not in TATOEBA_NAMES}
        per_corpus.append((w, succ, tot))
        del bi, st

    def mixed(ctx):
        acc = collections.Counter()
        wsum = 0.0
        for w, succ, tot in per_corpus:
            t = tot.get(ctx, 0)
            if t < 5:
                continue
            wsum += w
            for n, c in succ.get(ctx, {}).items():
                acc[n] += w * c / t
        if not wsum:
            return []
        return sorted(((p / wsum, n) for n, p in acc.items()), key=lambda x: (-x[0], x[1]))

    ctxs = [k for k in sorted(keys, key=lambda k: -counts[k])
            if any(k in succ for _, succ, _ in per_corpus)]
    bigrams = {}
    for p in ctxs:
        if len(bigrams) >= a.bigram_prev:
            break
        lst = [(pr, n) for pr, n in mixed(p)[: a.bigram_next] if pr >= a.bigram_minp]
        if not lst:
            continue
        flat = [a.bigram_scale]
        for pr, n in lst:
            q = int(round(pr * a.bigram_scale))
            if q < 1:
                break
            flat.extend([index[n], q])
        if len(flat) > 1:
            bigrams[p] = flat
    starts = mixed("<s>")
    if starts:
        flat = [a.bigram_scale]
        for pr, n in starts[: a.bigram_next * 3]:
            q = int(round(pr * a.bigram_scale))
            if q >= 1:
                flat.extend([index[n], q])
        bigrams["<s>"] = flat
    print("  bigram contexts: %d, successors: %d" %
          (len(bigrams), sum((len(v) - 1) // 2 for v in bigrams.values())), file=sys.stderr)

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
        # indices of capitalised words whose lower-case form is also valid
        "amb": amb,
        # context(lower) -> [total, nextIndex1, count1, nextIndex2, count2, ...]; "<s>" = sentence start.
        # Counts are P(next|context) * total (mixed over the corpora).
        "bigrams": bigrams,
        "bloom": bloom.to_json(),
        "sources": "OpenSubtitles2018 frequencies via hermitdave/FrequencyWords (CC-BY-SA 4.0); "
                   "word lists: Debian wngerman/wamerican, hunspell; bigrams/capitalisation: "
                   "Tatoeba (CC-BY 2.0 FR), Mozilla Common Voice sentence lists (CC0)",
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("[%s] wrote %s (%d words)" % (lang, a.out, len(keys)), file=sys.stderr)


if __name__ == "__main__":
    main()
