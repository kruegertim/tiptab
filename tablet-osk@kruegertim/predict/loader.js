// predict/loader.js — loads predict/data/<lang>.json and builds the in-memory
// indexes used by engine.js.  Pure ES module (no gi imports): the caller passes
// a readFile(path) function (GLib.file_get_contents in the shell, fs in node).
//
// Data format (written by tools/build_predict_data.py):
//   { v: 2, lang, n,
//     words:   [canonical spelling, ...]  sorted by lower-case key (UTF-16 code unit order)
//     f:       [round(16*ln(count)), ...] parallel to words
//     amb:     [index, ...]               capitalised words whose lower-case form is also a
//                                         word ("Essen"/"essen"): case is not forced for them
//     bigrams: { ctxLower: [total, next1, count1, next2, count2, ...], '<s>': sentence start }
//              v2: next = index into words; v1: next = lower-case key string
//     bloom:   { m, k, b: base64 }        all dictionary words (lower case), FNV-1a double hashing
//   }
// Version 1 files (no amb, successor strings) are still accepted.
//
// The lexicon is an *implicit trie*: because the keys are sorted, every trie
// node is a contiguous index range [lo, hi) at some depth; children are found
// with binary search.  This needs no build step at load time (measured faster
// than building an object/Map trie, see tests/predict/bench.mjs) and lets us
// compute subtree frequency mass with prefix sums.

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

const HAS_UPPER = /[A-ZÄÖÜ]/;

export const ALPHABET = 'abcdefghijklmnopqrstuvwxyzäöüß';

function decodeText(data) {
    if (typeof data === 'string')
        return data;
    if (data instanceof Uint8Array)
        return new TextDecoder('utf-8').decode(data);
    if (data instanceof ArrayBuffer)
        return new TextDecoder('utf-8').decode(new Uint8Array(data));
    // GLib.Bytes or similar
    if (data && typeof data.toArray === 'function')
        return new TextDecoder('utf-8').decode(data.toArray());
    throw new Error('readFile must return a string or Uint8Array');
}

const B64 = (() => {
    const t = new Uint8Array(128);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < A.length; i++)
        t[A.charCodeAt(i)] = i;
    return t;
})();

// Table-based decoder: much faster than atob() in node and available in gjs.
function base64ToBytes(b64) {
    let len = b64.length;
    while (len > 0 && b64.charCodeAt(len - 1) === 61 /* = */)
        len--;
    const out = new Uint8Array((len * 3) >> 2);
    const T = B64;
    let o = 0, i = 0;
    const full = len - (len % 4);
    for (; i < full; i += 4) {
        const n = (T[b64.charCodeAt(i)] << 18) | (T[b64.charCodeAt(i + 1)] << 12) |
            (T[b64.charCodeAt(i + 2)] << 6) | T[b64.charCodeAt(i + 3)];
        out[o++] = n >> 16;
        out[o++] = (n >> 8) & 0xff;
        out[o++] = n & 0xff;
    }
    const rem = len - i;
    if (rem >= 2) {
        const n = (T[b64.charCodeAt(i)] << 18) | (T[b64.charCodeAt(i + 1)] << 12) |
            (rem > 2 ? T[b64.charCodeAt(i + 2)] << 6 : 0);
        out[o++] = n >> 16;
        if (rem > 2)
            out[o++] = (n >> 8) & 0xff;
    }
    return out;
}

export class BloomFilter {
    constructor({m, k, b}) {
        this.m = m;
        this.k = k;
        this._b64 = b;
        this._bits = null;      // decoded lazily on first lookup
    }

    get bits() {
        if (!this._bits) {
            this._bits = base64ToBytes(this._b64);
            this._b64 = null;
        }
        return this._bits;
    }

    has(s) {
        let h1 = 0x811C9DC5, h2 = 0x01000193 ^ 0x5BD1E995;
        for (let i = 0; i < s.length; i++) {
            const u = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ u, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ u, 0x5BD1E995) >>> 0;
            h2 = (h2 ^ (h2 >>> 15)) >>> 0;
        }
        h2 = (h2 | 1) >>> 0;
        const bits = this.bits;
        for (let i = 0; i < this.k; i++) {
            const bit = (h1 + i * h2) % this.m;
            if (!(bits[bit >>> 3] & (1 << (bit & 7))))
                return false;
        }
        return true;
    }
}

export class Lexicon {
    constructor({words, f, bloom = null, lang = '?', amb = null}) {
        const n = words.length;
        this.lang = lang;
        this.size = n;
        this.words = words;
        this.keys = new Array(n);
        this.count = new Float64Array(n);       // estimated corpus counts
        this.cum = new Float64Array(n + 1);     // prefix sums of count
        let total = 0;
        for (let i = 0; i < n; i++) {
            const w = words[i];
            // most stored spellings are already lower case; only lower-case the others
            const c0 = w.charCodeAt(0);
            this.keys[i] = (c0 >= 97 && c0 <= 122 && !HAS_UPPER.test(w)) ? w : w.toLowerCase();
            const c = Math.exp(f[i] / 16);
            this.count[i] = c;
            total += c;
            this.cum[i + 1] = total;
        }
        this.total = total;
        const lt = Math.log(total);
        this.logp = new Float32Array(n);
        for (let i = 0; i < n; i++)
            this.logp[i] = f[i] / 16 - lt;
        this.bloom = bloom ? new BloomFilter(bloom) : null;
        this._amb = amb ? new Set(amb) : null;
        this._sparse = null;
        this._letterProbs = null;
        this._top = null;
    }

    /** index of exact lower-case key or -1 */
    indexOf(key) {
        let lo = 0, hi = this.size;
        const keys = this.keys;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (keys[m] < key)
                lo = m + 1;
            else
                hi = m;
        }
        return lo < this.size && keys[lo] === key ? lo : -1;
    }

    /** [lo, hi) range of keys starting with prefix (lower case) */
    range(prefix, lo = 0, hi = this.size) {
        if (!prefix)
            return [lo, hi];
        const keys = this.keys;
        let a = lo, b = hi;
        while (a < b) {
            const m = (a + b) >> 1;
            if (keys[m] < prefix)
                a = m + 1;
            else
                b = m;
        }
        const start = a;
        const upper = prefix + '￿';
        b = hi;
        while (a < b) {
            const m = (a + b) >> 1;
            if (keys[m] < upper)
                a = m + 1;
            else
                b = m;
        }
        return [start, a];
    }

    /** dictionary validity: in lexicon or in the (larger) dictionary bloom filter */
    isValid(key) {
        return this.indexOf(key) >= 0 || (this.bloom !== null && this.bloom.has(key));
    }

    /**
     * true if words[i] is a capitalised word that is only ever written that way
     * (German nouns like "Haus", English "Monday"): a lower-case spelling of it is
     * a case error.  False for lower-case/ALL-CAPS words and for case-ambiguous
     * words ("Essen"/"essen").  Without amb data (v1 files) nothing is forced.
     */
    isCapitalOnly(i) {
        if (i < 0 || !this._amb)
            return false;
        const w = this.words[i];
        const c0 = w.charCodeAt(0);
        if (c0 >= 97 && c0 <= 122)
            return false;
        if (w.length > 1 && w.slice(1) !== w.slice(1).toLowerCase())
            return false;     // ALL CAPS / mixed (acronyms, "McDonald")
        if (w.charAt(0) === w.charAt(0).toLowerCase())
            return false;     // starts with ä/ö/ü etc. in lower case
        return !this._amb.has(i);
    }

    mass(lo, hi) {
        return this.cum[hi] - this.cum[lo];
    }

    _buildSparse() {
        // sparse table for range-argmax over count
        const n = this.size, cnt = this.count;
        const levels = [];
        let prev = new Int32Array(n);
        for (let i = 0; i < n; i++)
            prev[i] = i;
        levels.push(prev);
        for (let span = 1; span * 2 <= n; span *= 2) {
            const len = n - span * 2 + 1;
            const cur = new Int32Array(len);
            for (let i = 0; i < len; i++) {
                const a = prev[i], b = prev[i + span];
                cur[i] = cnt[a] >= cnt[b] ? a : b;
            }
            levels.push(cur);
            prev = cur;
        }
        this._sparse = levels;
    }

    /** index of the most frequent word in [lo, hi) (hi > lo) */
    argmax(lo, hi) {
        const len = hi - lo;
        if (len <= 16) {
            let best = lo;
            for (let i = lo + 1; i < hi; i++) {
                if (this.count[i] > this.count[best])
                    best = i;
            }
            return best;
        }
        if (!this._sparse)
            this._buildSparse();
        const lvl = 31 - Math.clz32(len);
        const t = this._sparse[lvl];
        const a = t[lo], b = t[hi - (1 << lvl)];
        return this.count[a] >= this.count[b] ? a : b;
    }

    /** indices of the k most frequent words in [lo, hi), best first */
    topK(lo, hi, k) {
        const out = [];
        if (hi <= lo)
            return out;
        const heap = [[lo, hi, this.argmax(lo, hi)]];
        while (out.length < k && heap.length) {
            let bi = 0;
            for (let i = 1; i < heap.length; i++) {
                if (this.count[heap[i][2]] > this.count[heap[bi][2]])
                    bi = i;
            }
            const [a, b, m] = heap[bi];
            heap[bi] = heap[heap.length - 1];
            heap.pop();
            out.push(m);
            if (m > a)
                heap.push([a, m, this.argmax(a, m)]);
            if (m + 1 < b)
                heap.push([m + 1, b, this.argmax(m + 1, b)]);
        }
        return out;
    }

    /** most frequent words overall (cached) */
    topWords(k = 30) {
        if (!this._top || this._top.length < k)
            this._top = this.topK(0, this.size, k);
        return this._top.slice(0, k);
    }

    /**
     * Child char mass below the node `prefix`: calls fn(charCode, mass) for each
     * child character (only for keys longer than the prefix).
     */
    forEachChild(prefix, fn) {
        const [lo0, hi] = this.range(prefix);
        const d = prefix.length, keys = this.keys;
        let i = lo0;
        if (i < hi && keys[i].length === d)
            i++;
        while (i < hi) {
            const c = keys[i].charCodeAt(d);
            let a = i + 1, b = hi;
            while (a < b) {
                const m = (a + b) >> 1;
                if (keys[m].charCodeAt(d) <= c)
                    a = m + 1;
                else
                    b = m;
            }
            fn(c, this.cum[a] - this.cum[i], i, a);
            i = a;
        }
    }

    /** frequency-weighted letter distribution over ALPHABET (backoff for nextKeyProbs) */
    letterProbs() {
        if (this._letterProbs)
            return this._letterProbs;
        const idx = new Map();
        for (let i = 0; i < ALPHABET.length; i++)
            idx.set(ALPHABET.charCodeAt(i), i);
        const acc = new Float64Array(ALPHABET.length);
        for (let w = 0; w < this.size; w++) {
            const k = this.keys[w], c = this.count[w];
            for (let j = 0; j < k.length; j++) {
                const p = idx.get(k.charCodeAt(j));
                if (p !== undefined)
                    acc[p] += c;
            }
        }
        let s = 0;
        for (let i = 0; i < acc.length; i++) {
            acc[i] += 1e-6;
            s += acc[i];
        }
        for (let i = 0; i < acc.length; i++)
            acc[i] /= s;
        this._letterProbs = acc;
        return acc;
    }
}

export class Bigrams {
    /**
     * @param {object} table  ctx -> [total, next1, count1, ...]
     * @param {string[]} [keys]  lexicon keys; successors given as numbers are indices into it (v2)
     */
    constructor(table = {}, keys = null) {
        this.table = table;
        this._keys = keys;
        this._done = keys ? new Set() : null;
    }

    /** raw entry [total, w1, c1, ...] (w = lower-case key) or null; '<s>' for sentence start */
    get(ctx) {
        if (!Object.prototype.hasOwnProperty.call(this.table, ctx))
            return null;
        const e = this.table[ctx];
        if (this._done && !this._done.has(ctx)) {
            // v2: resolve successor indices to keys once, on first use
            for (let j = 1; j < e.length; j += 2) {
                if (typeof e[j] === 'number')
                    e[j] = this._keys[e[j]] ?? '';
            }
            this._done.add(ctx);
        }
        return e;
    }

    /** count of (ctx, key) and total of ctx; {count, total} or null if ctx unknown */
    lookup(ctx, key) {
        const e = this.get(ctx);
        if (!e)
            return null;
        for (let i = 1; i < e.length; i += 2) {
            if (e[i] === key)
                return {count: e[i + 1], total: e[0]};
        }
        return {count: 0, total: e[0]};
    }
}

/** Parse a data file (JSON text, bytes or already-parsed object). */
export function parseLanguageData(data) {
    const t0 = now();
    const obj = typeof data === 'object' && !(data instanceof Uint8Array) && !(data?.toArray)
        ? data : JSON.parse(decodeText(data));
    const t1 = now();
    if (obj.v !== 1 && obj.v !== 2)
        throw new Error(`unsupported prediction data version ${obj.v}`);
    const lexicon = new Lexicon({words: obj.words, f: obj.f, bloom: obj.bloom, lang: obj.lang,
        amb: obj.v >= 2 ? obj.amb ?? [] : null});
    const bigrams = new Bigrams(obj.bigrams || {}, obj.v >= 2 ? lexicon.keys : null);
    const t2 = now();
    return {lang: obj.lang, lexicon, bigrams, stats: {parseMs: t1 - t0, indexMs: t2 - t1}};
}

/**
 * Lazily loads and caches per-language data.
 *   new DataLoader({readFile, dataDir})
 *   readFile(path) -> string | Uint8Array | GLib.Bytes   (or a Promise of it for loadAsync)
 */
export class DataLoader {
    constructor({readFile, dataDir}) {
        this._readFile = readFile;
        this._dataDir = dataDir.replace(/\/$/, '');
        this._cache = new Map();
        this.stats = {};
    }

    path(lang) {
        if (!/^[a-z]{2}$/.test(lang))
            throw new Error(`bad language ${lang}`);
        return `${this._dataDir}/${lang}.json`;
    }

    has(lang) {
        return this._cache.has(lang);
    }

    load(lang) {
        if (this._cache.has(lang))
            return this._cache.get(lang);
        const t0 = now();
        const raw = this._readFile(this.path(lang));
        if (raw && typeof raw.then === 'function')
            throw new Error('readFile returned a Promise; use loadAsync()');
        return this._finish(lang, raw, now() - t0);
    }

    async loadAsync(lang) {
        if (this._cache.has(lang))
            return this._cache.get(lang);
        const t0 = now();
        const raw = await this._readFile(this.path(lang));
        if (this._cache.has(lang))
            return this._cache.get(lang);
        return this._finish(lang, raw, now() - t0);
    }

    _finish(lang, raw, readMs) {
        const res = parseLanguageData(raw);
        res.stats.readMs = readMs;
        this.stats[lang] = res.stats;
        this._cache.set(lang, res);
        return res;
    }

    /** drop a cached language (e.g. to free memory) */
    unload(lang) {
        this._cache.delete(lang);
    }
}
