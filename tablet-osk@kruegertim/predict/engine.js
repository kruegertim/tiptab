// predict/engine.js — word prediction, autocorrect and key probabilities.
// Pure ES module (no gi imports), unit-tested with node (tests/predict/).
//
//   const loader = new DataLoader({readFile, dataDir});
//   const engine = new PredictionEngine({loader, lang: 'de', layout: 'qwertz', userDict});
//   engine.suggest('Hal', 'ich')      -> 3 slots [alt, BEST, alt] (entries may be null)
//   engine.autocorrect('Hallp')       -> {replacement: 'Hallo', confidence: 0.97, original: 'Hallp'}
//   engine.nextKeyProbs('hall')       -> Map('o' => 0.8, ...)
//   engine.autocorrect('Maedchen')    -> {replacement: 'Mädchen', ...}   (ae/oe/ue/ss spelling)
//   engine.autocorrect('haus')        -> {replacement: 'Haus', kind: 'case', ...} (German noun)
//   engine.autocorrect('das', null)   -> {replacement: 'Das', kind: 'case', ...}  (sentence start,
//                                        only while autoCapitalize is on — see setAutoCapitalize)
//
// The contract form `new PredictionEngine({lexicon, bigrams, userDict})` works too
// (lexicon = Lexicon instance from loader.js, bigrams = Bigrams instance).

import {ALPHABET} from './loader.js';

// ---------------------------------------------------------------- keyboard geometry

// [row string, x of the first key's left edge] in key units; rows are 1 unit apart.
const LAYOUT_ROWS = {
    qwertz: [['1234567890ß', 1.0], ['qwertzuiopü', 1.5], ['asdfghjklöä', 1.75], ['yxcvbnm', 2.0]],
    qwerty: [['1234567890', 1.0], ['qwertyuiop', 1.5], ['asdfghjkl', 1.75], ['zxcvbnm', 2.0]],
};

/** Map(charCode -> Map(charCode -> distance in key units)) for keys within 1.3 units. */
export function buildAdjacency(layout) {
    const rows = LAYOUT_ROWS[layout] || LAYOUT_ROWS.qwertz;
    const pos = [];
    rows.forEach(([s, x0], r) => {
        for (let i = 0; i < s.length; i++)
            pos.push([s.charCodeAt(i), x0 + i + 0.5, r]);
    });
    const adj = new Map();
    for (const [a, ax, ay] of pos) {
        const m = new Map();
        for (const [b, bx, by] of pos) {
            if (a === b)
                continue;
            const d = Math.hypot(ax - bx, ay - by);
            if (d <= 1.3)
                m.set(b, d);
        }
        adj.set(a, m);
    }
    return adj;
}

// ---------------------------------------------------------------- error model
// Costs are negative natural-log likelihoods of a typing error.
const COST = {
    SUB_NEAR: 2.3,      // neighbouring key (same row / directly diagonal)
    SUB_DIAG: 2.9,      // farther diagonal neighbour
    SUB_FAR: 6.5,       // unrelated key
    SUB_SPECIAL: 1.4,   // a<->ä, o<->ö, u<->ü, s<->ß (umlaut forgotten)
    TRANSPOSE: 2.5,
    INS_NEAR: 3.0,      // extra key typed, neighbour of an adjacent letter or doubled
    INS_FAR: 5.0,
    INS_DOUBLE: 2.6,    // letter doubled by mistake (Rhythmuss, wiederrum)
    INS_H: 2.6,         // German: "h" after a vowel (nähmlich, ziehmlich)
    DEL: 3.2,           // letter missed
    DEL_DOUBLE: 2.4,    // one of a double letter missed (halo -> hallo)
    SUB_VOWEL: 5.5,     // vowel for vowel (spelling: seperat -> separat, definately)
    UMLAUT_DIGRAPH: 0.5, // "ae"/"oe"/"ue" typed for ä/ö/ü (no umlaut keys, Swiss/ASCII habit)
    SS_ESZETT: 0.9,     // "ss" typed for ß (Strasse -> Straße)
};
const SPECIAL_PAIRS = new Set(['aä', 'äa', 'oö', 'öo', 'uü', 'üu', 'sß', 'ßs']);
const VOWELS = new Set([...'aeiouyäöü'].map(c => c.charCodeAt(0)));
// typed digraph (two char codes) -> the single letter it stands for
const DIGRAPHS = new Map([['ae', 'ä'], ['oe', 'ö'], ['ue', 'ü'], ['ss', 'ß']].map(
    ([d, u]) => [d.charCodeAt(0) * 65536 + d.charCodeAt(1), u.charCodeAt(0)]));
const DIGRAPH_RE = /ae|oe|ue|ss/g;
const MAX_UMLAUT_VARIANTS = 16;

// Fixed whole-word replacements: missing apostrophes and words that are really two
// words.  Applied before the dictionary check, because some of them are rare valid
// words ("cant", "wont") that people practically never mean.
const FIXES = {
    en: {
        im: "I'm", ive: "I've", youre: "you're", youve: "you've", youll: "you'll",
        theyre: "they're", theyve: "they've", theyll: "they'll", weve: "we've",
        cant: "can't", wont: "won't", dont: "don't", didnt: "didn't", doesnt: "doesn't",
        isnt: "isn't", wasnt: "wasn't", arent: "aren't", werent: "weren't",
        hasnt: "hasn't", havent: "haven't", hadnt: "hadn't", couldnt: "couldn't",
        wouldnt: "wouldn't", shouldnt: "shouldn't", mustnt: "mustn't", neednt: "needn't",
        whats: "what's", thats: "that's", theres: "there's", heres: "here's",
        wheres: "where's", whos: "who's", hows: "how's", itll: "it'll",
        couldve: "could've", wouldve: "would've", shouldve: "should've",
        shes: "she's", hes: "he's", alot: 'a lot', infront: 'in front', aswell: 'as well',
    },
    de: {
        garnicht: 'gar nicht', garkein: 'gar kein', garkeine: 'gar keine', garnichts: 'gar nichts',
        vorallem: 'vor allem', aufjedenfall: 'auf jeden Fall', ausversehen: 'aus Versehen',
        bisjetzt: 'bis jetzt', aufeinmal: 'auf einmal', zuende: 'zu Ende', imoment: 'im Moment',
        bisbald: 'bis bald', bismorgen: 'bis morgen', vielspaß: 'viel Spaß', vielspass: 'viel Spaß',
        tschuess: 'tschüss',
    },
};

// log prior of "the user meant exactly this unknown string" (names, slang, compounds)
const LITERAL_LOGP = -14.5;
const LITERAL_PER_LETTER = 0.15;     // longer unknown strings are less likely meant literally
const COMPOUND_LITERAL_BONUS = 3.0;  // unknown string that splits into two words (German compounds)
const CAPITAL_LITERAL_BONUS = 1.5;   // unknown Capitalised word: often a name ("Kevin" -> not "Kein")
const EXACT_BONUS = Math.log(2.0);
const BIGRAM_LAMBDA = 0.5;
// search two-edit candidates only if the best one-edit candidate scores below this
const DEEPEN_BELOW = -11.0;
// work bounds for the fuzzy trie search
const MAX_TWO_EDIT_LEN = 12;    // longer words: one edit only
const MAX_FUZZY_LEN = 24;       // longer words: no fuzzy search at all
const SEARCH_BUDGET = 6000;     // max trie nodes visited per search pass

// ---------------------------------------------------------------- text helpers

const LETTER_RE = /^[\p{L}][\p{L}'’-]*$/u;

/** first letter upper case (Unicode aware for ä/ö/ü) */
function capitalize(w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
}
const UPPER_RE = /\p{Lu}/u;
const LOWER_RE = /\p{Ll}/u;

/** 'lower' | 'capital' | 'upper' | 'mixed' */
export function casePattern(s) {
    if (!UPPER_RE.test(s))
        return 'lower';
    const letters = [...s].filter(c => UPPER_RE.test(c) || LOWER_RE.test(c));
    if (letters.length >= 2 && !LOWER_RE.test(s))
        return 'upper';
    const first = letters[0];
    const rest = letters.slice(1).join('');
    if (first && UPPER_RE.test(first) && !UPPER_RE.test(rest))
        return 'capital';
    return 'mixed';
}

/** apply the case pattern of `typed` to the canonical `word` */
export function applyCase(typed, word) {
    switch (casePattern(typed)) {
    case 'upper':
        return word.toUpperCase();
    case 'capital':
        return word.charAt(0).toUpperCase() + word.slice(1);
    default:
        return word;
    }
}

/** true for tokens that must never be corrected/learned: numbers, URLs, mail, paths, mixed alnum */
export function isProtectedToken(s) {
    if (!s)
        return true;
    if (/\d/.test(s))
        return true;
    if (/[@/\\:_#&=~+*%$<>|{}[\]]/.test(s))
        return true;
    if (/^www\./i.test(s) || /\.[a-z]/i.test(s))
        return true;
    return !LETTER_RE.test(s);
}

function normKey(s) {
    return s.replace(/’/g, "'").toLowerCase();
}

/** strip surrounding punctuation from a context word; returns {key, sentenceStart} */
function contextOf(prevWord) {
    if (prevWord === null || prevWord === undefined)
        return {key: null, sentenceStart: true};
    const s = String(prevWord).trim();
    if (s === '')
        return {key: null, sentenceStart: true};
    if (/[.!?]["')\]]*$/.test(s) || /[\n]$/.test(prevWord))
        return {key: null, sentenceStart: true};
    const core = s.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
    if (!core || /[,;:]$/.test(s))
        return {key: core ? normKey(core) : null, sentenceStart: false};
    return {key: normKey(core), sentenceStart: false};
}

// ---------------------------------------------------------------- user dictionary (memory)

const MAX_USER_WORDS = 5000;

/**
 * In-memory user dictionary. store.js's UserDict extends this with persistence.
 * Data: {v:1, langs: {de: {key: {w, n, t}}}, blocked: {de: {key: 1}}}
 */
export class MemoryUserDict {
    constructor(data = null) {
        this._private = false;
        this._load(data);
    }

    _load(data) {
        this.data = data && data.v === 1 ? data : {v: 1, langs: {}, blocked: {}};
        this.data.langs ??= {};
        this.data.blocked ??= {};
        this._learnedCache = new Map();
    }

    /** private mode (password/PIN fields): nothing is recorded */
    setPrivate(on) {
        this._private = !!on;
    }

    get isPrivate() {
        return this._private;
    }

    _lang(lang) {
        return (this.data.langs[lang] ??= {});
    }

    _changed(lang) {
        this._learnedCache.delete(lang);
        this.changed?.();
    }

    get(lang, key) {
        const l = this.data.langs[lang];
        return l && Object.prototype.hasOwnProperty.call(l, key) ? l[key] : null;
    }

    isLearned(lang, key) {
        const e = this.get(lang, key);
        return !!e && e.n >= 2;
    }

    /** record one "kept" occurrence; returns the new count (0 when private) */
    increment(lang, key, word) {
        if (this._private)
            return 0;
        const l = this._lang(lang);
        const e = l[key] ?? (l[key] = {w: word, n: 0, t: 0});
        e.n += 1;
        e.w = word;
        e.t = Date.now();
        this._prune(l);
        this._changed(lang);
        return e.n;
    }

    decrement(lang, key) {
        const l = this.data.langs[lang];
        if (!l || !l[key])
            return 0;
        l[key].n -= 1;
        const n = l[key].n;
        if (n <= 0)
            delete l[key];
        this._changed(lang);
        return Math.max(0, n);
    }

    remove(lang, key) {
        let changed = false;
        if (this.data.langs[lang]?.[key]) {
            delete this.data.langs[lang][key];
            changed = true;
        }
        if (this.data.blocked[lang]?.[key]) {
            delete this.data.blocked[lang][key];
            changed = true;
        }
        if (changed)
            this._changed(lang);
        return changed;
    }

    block(lang, key) {
        if (this._private)
            return;
        (this.data.blocked[lang] ??= {})[key] = 1;
        this._changed(lang);
    }

    isBlocked(lang, key) {
        return !!this.data.blocked[lang]?.[key];
    }

    /** learned entries [{key, w, n}] (n >= 2), sorted by key */
    learned(lang) {
        let c = this._learnedCache.get(lang);
        if (!c) {
            const l = this.data.langs[lang] ?? {};
            c = Object.keys(l).filter(k => l[k].n >= 2).sort()
                .map(k => ({key: k, w: l[k].w, n: l[k].n}));
            this._learnedCache.set(lang, c);
        }
        return c;
    }

    clear() {
        this.data = {v: 1, langs: {}, blocked: {}};
        this._learnedCache.clear();
        this.changed?.();
    }

    _prune(l) {
        const keys = Object.keys(l);
        if (keys.length <= MAX_USER_WORDS)
            return;
        // drop single sightings first, then least recently used
        keys.sort((a, b) => (l[a].n >= 2) - (l[b].n >= 2) || l[a].t - l[b].t);
        for (let i = 0; i < keys.length - MAX_USER_WORDS; i++)
            delete l[keys[i]];
    }

    toJSON() {
        return this.data;
    }
}

// ---------------------------------------------------------------- engine

export class PredictionEngine {
    /**
     * @param {object} o
     * @param {Lexicon} [o.lexicon]  @param {Bigrams} [o.bigrams]   data for o.lang
     * @param {DataLoader} [o.loader]  used by setLanguage() to load other languages lazily
     * @param {string} [o.lang='de']  @param {string} [o.layout='qwertz']
     * @param {MemoryUserDict} [o.userDict]
     */
    constructor({lexicon = null, bigrams = null, userDict = null, loader = null,
        lang = null, layout = 'qwertz', autoCapitalize = false} = {}) {
        this._loader = loader;
        this.autoCapitalize = !!autoCapitalize;
        this.userDict = userDict ?? new MemoryUserDict();
        this.lang = lang ?? lexicon?.lang ?? 'de';
        this.lexicon = lexicon;
        this.bigrams = bigrams;
        if (!this.lexicon && loader)
            this.setLanguage(this.lang);
        this.setLayout(layout);
    }

    /**
     * Sentence-start capitalisation (default off): when on, a word typed in lower case at the start of a
     * sentence (prevWord null/'' or ending in . ! ?) is capitalised by autocorrect() and in
     * suggest().  Turn it off for fields whose content hints ask for lower case or where
     * capitals make no sense (URL, e-mail, user names) and when the caller does not know
     * the text before the cursor (prevWord null would then be a guess).
     */
    setAutoCapitalize(on) {
        this.autoCapitalize = !!on;
    }

    /** 'qwertz' | 'qwerty' — used for the keyboard-adjacency error model */
    setLayout(layout) {
        this.layout = layout === 'qwerty' ? 'qwerty' : 'qwertz';
        this._adj = buildAdjacency(this.layout);
    }

    /** 'de' | 'en'; loads the data through the loader (synchronously) if needed */
    setLanguage(lang) {
        if (lang === this.lang && this.lexicon)
            return;
        if (!this._loader)
            throw new Error('setLanguage needs a loader');
        const d = this._loader.load(lang);
        this.lang = lang;
        this.lexicon = d.lexicon;
        this.bigrams = d.bigrams;
    }

    /** async variant for a loader whose readFile returns a Promise */
    async setLanguageAsync(lang) {
        if (lang === this.lang && this.lexicon)
            return;
        const d = await this._loader.loadAsync(lang);
        this.lang = lang;
        this.lexicon = d.lexicon;
        this.bigrams = d.bigrams;
    }

    /**
     * Build the lazily created indexes (range-max table, letter backoff, bloom
     * bits) now — call from an idle callback after loading so the first
     * keystroke does not pay ~40-80 ms.
     */
    warmUp() {
        if (!this.lexicon)
            return;
        const lex = this.lexicon;
        lex.argmax(0, lex.size);
        lex.letterProbs();
        lex.topWords(30);
        lex.bloom?.has('a');
    }

    get ready() {
        return !!this.lexicon;
    }

    // ------------------------------------------------------------ scoring helpers

    _ctxLogP(ctx, key, logp) {
        if (!ctx || !this.bigrams)
            return logp;
        const b = this.bigrams.lookup(ctx, key);
        if (!b)
            return logp;
        return Math.log(BIGRAM_LAMBDA * b.count / b.total + (1 - BIGRAM_LAMBDA) * Math.exp(logp));
    }

    _userLogP(entry) {
        return Math.log(2e-5) + 0.5 * Math.log(Math.min(entry.n, 50));
    }

    /** canonical spelling and log prior for a lower-case key, or null */
    _entry(key) {
        const i = this.lexicon.indexOf(key);
        if (i >= 0)
            return {key, word: this.lexicon.words[i], logp: this.lexicon.logp[i], user: false};
        const u = this.userDict.get(this.lang, key);
        if (u && u.n >= 2)
            return {key, word: u.w, logp: this._userLogP(u), user: true};
        return null;
    }

    _subCost(a, b) {
        if (a === b)
            return 0;
        if (SPECIAL_PAIRS.has(String.fromCharCode(a, b)))
            return COST.SUB_SPECIAL;
        const d = this._adj.get(a)?.get(b);
        if (d === undefined)
            return VOWELS.has(a) && VOWELS.has(b) ? COST.SUB_VOWEL : COST.SUB_FAR;
        return d <= 1.1 ? COST.SUB_NEAR : COST.SUB_DIAG;
    }

    _isNear(a, b) {
        return a === b || (this._adj.get(a)?.has(b) ?? false);
    }

    /**
     * Weighted optimal-string-alignment distance from typed q to candidate w (both lower case).
     * prefixMode: w may continue after the aligned part (completion of a mistyped prefix).
     */
    errorCost(q, w, prefixMode = false) {
        const n = q.length, m = w.length;
        // reuse one flat buffer for the DP matrix (rows of m+1)
        const need = (n + 1) * (m + 1);
        if (!this._dpBuf || this._dpBuf.length < need)
            this._dpBuf = new Float64Array(Math.max(need, 1024));
        const buf = this._dpBuf, W1 = m + 1;
        const D = [];
        for (let i = 0; i <= n; i++)
            D.push(buf.subarray(i * W1, i * W1 + W1));
        const qc = [], wc = [];
        for (let i = 0; i < n; i++)
            qc.push(q.charCodeAt(i));
        for (let j = 0; j < m; j++)
            wc.push(w.charCodeAt(j));
        D[0][0] = 0;
        const de = this.lang === 'de';
        const insCost = i => { // typed qc[i] is extra
            const prev = i > 0 ? qc[i - 1] : -1, next = i + 1 < n ? qc[i + 1] : -1;
            if (qc[i] === prev || qc[i] === next)
                return COST.INS_DOUBLE;
            if (de && qc[i] === 104 /* h */ && VOWELS.has(prev))
                return COST.INS_H;
            return (this._isNear(qc[i], prev) || this._isNear(qc[i], next)) ? COST.INS_NEAR : COST.INS_FAR;
        };
        const delCost = j => (j > 0 && wc[j] === wc[j - 1]) || (j + 1 < m && wc[j] === wc[j + 1])
            ? COST.DEL_DOUBLE : COST.DEL;
        for (let i = 1; i <= n; i++)
            D[i][0] = D[i - 1][0] + insCost(i - 1);
        for (let j = 1; j <= m; j++)
            D[0][j] = D[0][j - 1] + delCost(j - 1);
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                let v = D[i - 1][j - 1] + this._subCost(qc[i - 1], wc[j - 1]);
                const ins = D[i - 1][j] + insCost(i - 1);
                if (ins < v)
                    v = ins;
                const del = D[i][j - 1] + delCost(j - 1);
                if (del < v)
                    v = del;
                if (i > 1 && j > 1 && qc[i - 1] === wc[j - 2] && qc[i - 2] === wc[j - 1] &&
                    qc[i - 1] !== qc[i - 2]) {
                    const t = D[i - 2][j - 2] + COST.TRANSPOSE;
                    if (t < v)
                        v = t;
                }
                if (i > 1 && DIGRAPHS.get(qc[i - 2] * 65536 + qc[i - 1]) === wc[j - 1]) {
                    const t = D[i - 2][j - 1] + (wc[j - 1] === 0xdf ? COST.SS_ESZETT : COST.UMLAUT_DIGRAPH);
                    if (t < v)
                        v = t;
                }
                D[i][j] = v;
            }
        }
        if (!prefixMode)
            return D[n][m];
        let best = Infinity;
        for (let j = Math.max(0, n - 2); j <= m; j++) {
            if (D[n][j] < best)
                best = D[n][j];
        }
        return best;
    }

    /**
     * Trie-guided Damerau-Levenshtein (OSA, unit cost) search over the implicit
     * trie of the lexicon.  Branches whose DP row minimum exceeds maxEdits are
     * pruned.  Calls onWord(index, edits) for whole-word matches and, if
     * prefixEdits >= 0, onPrefix(lo, hi, edits) for trie nodes whose prefix
     * matches the whole query (fuzzy completions; only the shallowest node).
     */
    _fuzzy(q, maxEdits, prefixEdits, onWord, onPrefix, budget = SEARCH_BUDGET) {
        const lex = this.lexicon, keys = lex.keys;
        const n = q.length;
        const qc = new Int32Array(n);
        for (let i = 0; i < n; i++)
            qc[i] = q.charCodeAt(i);
        const maxDepth = n + maxEdits;
        const rows = [];
        for (let d = 0; d <= maxDepth + 1; d++)
            rows.push(new Int32Array(n + 1));
        for (let i = 0; i <= n; i++)
            rows[0][i] = i;
        const path = new Int32Array(maxDepth + 2);

        let visits = 0;
        const visit = (lo, hi, depth, prefixDone) => {
            if (++visits > budget)
                return;             // hard work bound (keeps worst cases < ~2 ms)
            const row = rows[depth];
            const lo0 = lo;
            if (keys[lo].length === depth) {
                if (row[n] <= maxEdits)
                    onWord(lo, row[n]);
                lo++;
            }
            if (prefixEdits >= 0 && !prefixDone && depth >= n - 1 && depth >= 2 && row[n] <= prefixEdits) {
                onPrefix(lo0, hi, row[n]);
                prefixDone = true;
            }
            if (depth >= maxDepth)
                return;
            const next = rows[depth + 1], grand = depth > 0 ? rows[depth - 1] : null;
            const pc = depth > 0 ? path[depth - 1] : -1;
            let i = lo;
            while (i < hi) {
                const c = keys[i].charCodeAt(depth);
                let a = i + 1, b = hi;
                while (a < b) {
                    const mid = (a + b) >> 1;
                    if (keys[mid].charCodeAt(depth) <= c)
                        a = mid + 1;
                    else
                        b = mid;
                }
                next[0] = depth + 1;
                let rmin = next[0];
                for (let x = 1; x <= n; x++) {
                    let v = row[x - 1] + (qc[x - 1] === c ? 0 : 1);
                    const up = row[x] + 1, left = next[x - 1] + 1;
                    if (up < v)
                        v = up;
                    if (left < v)
                        v = left;
                    if (grand && x > 1 && qc[x - 1] === pc && qc[x - 2] === c) {
                        const t = grand[x - 2] + 1;
                        if (t < v)
                            v = t;
                    }
                    next[x] = v;
                    if (v < rmin)
                        rmin = v;
                }
                if (rmin <= maxEdits) {
                    path[depth] = c;
                    visit(i, a, depth + 1, prefixDone);
                }
                i = a;
            }
        };
        if (lex.size > 0)
            visit(0, lex.size, 0, false);
        return visits <= budget;
    }

    /**
     * Spellings of q with ae/oe/ue/ss replaced by ä/ö/ü/ß (German only), q itself excluded.
     * "muessen" -> ["müssen"], "strasse" -> ["straße"]; at most MAX_UMLAUT_VARIANTS.
     */
    _umlautVariants(q) {
        if (this.lang !== 'de' || q.length < 3)
            return [];
        const pos = [];
        DIGRAPH_RE.lastIndex = 0;
        let m;
        while ((m = DIGRAPH_RE.exec(q)) !== null) {
            pos.push(m.index);
            DIGRAPH_RE.lastIndex = m.index + 1;   // overlapping: "sss", "uee"
        }
        if (!pos.length)
            return [];
        const out = new Set();
        const n = Math.min(pos.length, 4);
        for (let mask = 1; mask < (1 << n) && out.size < MAX_UMLAUT_VARIANTS; mask++) {
            let v = '', last = 0, ok = true;
            for (let b = 0; b < n; b++) {
                if (!(mask & (1 << b)))
                    continue;
                const p = pos[b];
                if (p < last) {      // overlaps the previous replacement
                    ok = false;
                    break;
                }
                v += q.slice(last, p) + String.fromCharCode(DIGRAPHS.get(q.charCodeAt(p) * 65536 + q.charCodeAt(p + 1)));
                last = p + 2;
            }
            if (ok)
                out.add(v + q.slice(last));
        }
        return [...out];
    }

    _maxEdits(len) {
        if (len <= 2 || len > MAX_FUZZY_LEN)
            return 0;
        if (len <= 4 || len > MAX_TWO_EDIT_LEN)
            return 1;
        return 2;
    }

    /** is `key` a word the user may legitimately mean (lexicon, dictionary, learned, compound)? */
    isKnownWord(word) {
        const key = normKey(word);
        if (!this.lexicon)
            return false;
        return this._isDictWord(key) || (this.lang === 'de' && this._isCompound(key));
    }

    /** in lexicon, dictionary (bloom) or learned — without the compound heuristic */
    _isDictWord(key) {
        if (this.lexicon.isValid(key))
            return true;
        if (this.userDict.isLearned(this.lang, key))
            return true;
        if (this.lang === 'en' && key.endsWith("'s") && this.lexicon.isValid(key.slice(0, -2)))
            return true;
        return false;
    }

    /** German compound check: key = A + [s|n|en|e|es]? + B, A and B valid, each >= 3 letters */
    _isCompound(key) {
        if (key.length < 7)
            return false;
        const lex = this.lexicon;
        for (let i = 3; i <= key.length - 3; i++) {
            const a = key.slice(0, i);
            if (!lex.isValid(a))
                continue;
            for (const fuge of ['', 's', 'n', 'en', 'e', 'es']) {
                if (fuge && !key.startsWith(fuge, i))
                    continue;
                const b = key.slice(i + fuge.length);
                if (b.length >= 3 && (lex.isValid(b) || this._isCompoundTail(b)))
                    return true;
            }
        }
        return false;
    }

    _isCompoundTail(b) {
        // allow one more split for three-part compounds
        if (b.length < 6)
            return false;
        for (let i = 3; i <= b.length - 3; i++) {
            if (this.lexicon.isValid(b.slice(0, i)) && this.lexicon.isValid(b.slice(i)))
                return true;
        }
        return false;
    }

    /**
     * Fuzzy candidate search with iterative deepening: one edit first; two edits
     * (for words >= 5 letters) only when the 1-edit candidates are poor.  The
     * last result is memoised because suggest() and autocorrect() ask for the
     * same word right after each other.
     * Returns {words: [lexicon index], prefixNodes: [[lo, hi]]}.
     */
    _search(q) {
        const memo = this._memo;
        if (memo && memo.q === q && memo.lex === this.lexicon)
            return memo.res;
        const lex = this.lexicon;
        const words = new Set(), prefixNodes = [];
        const maxEdits = this._maxEdits(q.length);
        if (maxEdits > 0) {
            let best = -Infinity;
            this._fuzzy(q, 1, q.length >= 4 ? 1 : -1, i => {
                if (lex.keys[i] === q || words.has(i))
                    return;
                words.add(i);
                const sc = lex.logp[i] - this.errorCost(q, lex.keys[i]);
                if (sc > best)
                    best = sc;
            }, (a, b, d) => {
                if (d > 0)
                    prefixNodes.push([a, b]);
            });
            // a string that is still a valid trie path is most likely an unfinished word:
            // completions cover it, so skip the (expensive) two-edit pass
            const [plo, phi] = lex.range(q);
            if (maxEdits >= 2 && best < DEEPEN_BELOW && phi === plo)
                this._fuzzy(q, 2, -1, i => {
                    if (lex.keys[i] !== q)
                        words.add(i);
                }, null);
        }
        // ae/oe/ue/ss spellings of umlauts and ß: exact words and completions
        for (const v of this._umlautVariants(q)) {
            const i = lex.indexOf(v);
            if (i >= 0)
                words.add(i);
            if (q.length >= 3) {
                const [a, b] = lex.range(v);
                if (b > a && !(b - a === 1 && i >= 0))
                    prefixNodes.push([a, b, true]);
            }
        }
        const res = {words: [...words], prefixNodes};
        this._memo = {q, lex: this.lexicon, res};
        return res;
    }

    /** scored correction candidates for a typed (lower-case) word, best first */
    _corrections(q, ctx, maxEdits) {
        const lex = this.lexicon;
        const out = [];
        for (const i of this._search(q).words) {
            const key = lex.keys[i];
            if (key === q)
                continue;
            const err = this.errorCost(q, key);
            const score = this._ctxLogP(ctx, key, lex.logp[i]) - err;
            out.push({key, word: lex.words[i], score, err});
        }
        for (const u of this.userDict.learned(this.lang)) {
            if (u.key === q || Math.abs(u.key.length - q.length) > maxEdits)
                continue;
            const err = this.errorCost(q, u.key);
            if (err <= maxEdits * COST.SUB_FAR)
                out.push({key: u.key, word: u.w, score: this._userLogP(u) - err, err, user: true});
        }
        out.sort((a, b) => b.score - a.score);
        return out;
    }

    // ------------------------------------------------------------ public API

    /**
     * Autocorrection for a finished word (call on space/punctuation).
     * Returns {replacement, confidence, original} or null. Never touches valid
     * words, learned words, blocked words, numbers, URLs, e-mail addresses or
     * mixed-case/alphanumeric tokens.
     */
    autocorrect(word, prevWord = null) {
        if (!this.lexicon || typeof word !== 'string')
            return null;
        if (this.lang === 'en' && word === 'i')   // the one case-only fix iOS also does
            return {replacement: 'I', confidence: 0.99, original: word, kind: 'case'};
        if (word.length < 2 || word.length > 24 || isProtectedToken(word) || word.includes('-'))
            return null;
        const pattern = casePattern(word);
        if (pattern === 'mixed')
            return null;
        const q = normKey(word);
        if (this.userDict.isBlocked(this.lang, q) || this.userDict.isLearned(this.lang, q))
            return null;
        const ctx = contextOf(prevWord);
        // sentence start: capitalise the result when the user typed lower case
        const capStart = this.autoCapitalize && ctx.sentenceStart && pattern === 'lower';
        const finish = (replacement, confidence, kind) => {
            if (capStart)
                replacement = capitalize(replacement);
            return replacement === word ? null : {replacement, confidence, original: word, kind};
        };
        const fix = FIXES[this.lang]?.[q];
        if (fix && pattern !== 'upper')
            return finish(applyCase(word, fix), 0.95, 'phrase');
        if (word.length < 3 && !capStart)
            return null;
        // a German string that only splits into two words ("wiederrum" = wieder+rum) is
        // probably a compound, but may still be a typo of a frequent word: correct it only
        // with a much stronger candidate
        const compoundOnly = !this._isDictWord(q) && this.lang === 'de' && this._isCompound(q);
        if (!compoundOnly && this.isKnownWord(q)) {
            // valid word: only its capitalisation can be wrong
            if (pattern !== 'lower')
                return null;
            const i = this.lexicon.indexOf(q);
            if (this.lexicon.isCapitalOnly(i))
                return finish(this.lexicon.words[i], 0.95, 'case');
            return capStart ? finish(word, 0.9, 'case') : null;
        }
        if (word.length < 3)
            return null;
        const cands = this._corrections(q, ctx.key, this._maxEdits(q.length));
        if (!cands.length)
            return null;
        // posterior over candidates + "user meant the literal string"
        const lit = LITERAL_LOGP - LITERAL_PER_LETTER * Math.max(0, q.length - 6) +
            (compoundOnly ? COMPOUND_LITERAL_BONUS : 0) +
            (pattern === 'capital' && !ctx.sentenceStart && !/^\p{Lu}/u.test(cands[0].word) ? CAPITAL_LITERAL_BONUS : 0);
        const best = cands[0].score;
        let z = Math.exp(lit - best);
        for (const c of cands)
            z += Math.exp(c.score - best);
        const confidence = 1 / z;
        const threshold = compoundOnly ? 0.9 : q.length <= 3 ? 0.8 : 0.6;
        if (confidence < threshold)
            return null;
        return finish(applyCase(word, cands[0].word), confidence, 'typo');
    }

    /**
     * Suggestions for the word being typed (prefix) or, with prefix '', next-word
     * predictions after prevWord.  Returns `max` slots (null = empty) in iOS order:
     *   [0] literal typed text (kind 'literal', render in quotes) when an autocorrection
     *       would apply or the text is unknown; otherwise the typed word itself if it is
     *       a valid word (kind 'completion', exact: true) or the 2nd best candidate
     *   [1] BEST guess ('correction' when autocorrect would replace on space —
     *       then item.autocorrect === true)
     *   [2..] further alternatives
     * Items: {word, score, kind: 'literal'|'completion'|'correction'|'next', exact?, autocorrect?}
     */
    suggest(prefix, prevWord = null, max = 3) {
        const slots = new Array(Math.max(1, max)).fill(null);
        if (!this.lexicon)
            return slots;
        if (!prefix)
            return this._nextWords(prevWord, slots);
        if (isProtectedToken(prefix) || prefix.length > 40)
            return slots;

        const lex = this.lexicon;
        const q = normKey(prefix);
        const ctx = contextOf(prevWord).key;
        const cands = new Map(); // key -> item
        const add = (key, word, score, kind, exact = false) => {
            const old = cands.get(key);
            if (!old || old.score < score)
                cands.set(key, {key, word, score, kind, exact});
        };

        // exact prefix completions
        const [lo, hi] = lex.range(q);
        for (const i of lex.topK(lo, hi, 8)) {
            const key = lex.keys[i];
            const exact = key === q;
            add(key, lex.words[i], this._ctxLogP(ctx, key, lex.logp[i]) + (exact ? EXACT_BONUS : 0),
                'completion', exact);
        }
        const exactIdx = lex.indexOf(q);
        if (exactIdx >= 0 && !cands.has(q))
            add(q, lex.words[exactIdx], this._ctxLogP(ctx, q, lex.logp[exactIdx]) + EXACT_BONUS, 'completion', true);
        // bigram successors matching the prefix (context boost for rarer words)
        const bEntry = ctx && this.bigrams ? this.bigrams.get(ctx) : null;
        if (bEntry) {
            for (let j = 1; j < bEntry.length; j += 2) {
                const key = bEntry[j];
                if (key.startsWith(q)) {
                    const e = this._entry(key);
                    if (e)
                        add(key, e.word, this._ctxLogP(ctx, key, e.logp) + (key === q ? EXACT_BONUS : 0), 'completion', key === q);
                }
            }
        }
        // learned user words
        for (const u of this.userDict.learned(this.lang)) {
            if (u.key.startsWith(q))
                add(u.key, u.w, this._userLogP(u) + (u.key === q ? EXACT_BONUS : 0), 'completion', u.key === q);
        }

        // fuzzy: whole-word corrections and completions of a mistyped prefix
        const known = this.isKnownWord(q);
        // a valid typed word makes typo hypotheses less likely
        const knownPenalty = known ? 1.5 : 0;
        if (q.length >= 3) {
            const found = this._search(q);
            for (const i of found.words) {
                const key = lex.keys[i];
                const err = this.errorCost(q, key) + knownPenalty;
                add(key, lex.words[i], this._ctxLogP(ctx, key, lex.logp[i]) - err, 'correction');
            }
            for (const [a, b, umlaut] of found.prefixNodes) {
                for (const i of lex.topK(a, b, 2)) {
                    const key = lex.keys[i];
                    // (umlaut spellings may improve a whole-word candidate's score:
                    // "schoe" -> "schön" scores as a completion, not as a 1-letter word)
                    if (umlaut ? cands.get(key)?.kind === 'completion' : cands.has(key))
                        continue;
                    const err = this.errorCost(q, key, true) + knownPenalty;
                    add(key, lex.words[i], this._ctxLogP(ctx, key, lex.logp[i]) - err, 'correction');
                }
            }
        }

        const ac = this.autocorrect(prefix, prevWord);
        const ranked = [...cands.values()].sort((a, b) => b.score - a.score);
        const capStart = this.autoCapitalize && casePattern(prefix) === 'lower' &&
            contextOf(prevWord).sentenceStart;
        const toItem = c => ({word: capStart ? capitalize(applyCase(prefix, c.word)) : applyCase(prefix, c.word),
            score: c.score, kind: c.kind, exact: c.exact});

        const order = [];
        let first;
        if (ac) {
            first = {word: prefix, score: LITERAL_LOGP, kind: 'literal', exact: true};
            const acKey = normKey(ac.replacement);
            const best = ranked.find(c => c.key === acKey);
            order.push({word: ac.replacement, score: best ? best.score : 0, kind: 'correction',
                autocorrect: true, confidence: ac.confidence});
            for (const c of ranked) {
                if (c.key !== acKey)
                    order.push(toItem(c));
            }
        } else if (known) {
            const exact = ranked.find(c => c.key === q);
            first = exact ? toItem(exact) : {word: prefix, score: LITERAL_LOGP, kind: 'completion', exact: true};
            first.exact = true;
            for (const c of ranked) {
                if (c.key !== q)
                    order.push(toItem(c));
            }
        } else {
            first = {word: prefix, score: LITERAL_LOGP, kind: 'literal', exact: true};
            for (const c of ranked)
                order.push(toItem(c));
        }
        // de-duplicate (case-insensitive) against the first slot
        // (a literal only blocks its exact spelling, so 'i' -> 'I' can still be offered)
        const keyOf = w => (first.kind === 'literal' && w === first.word ? `\0${w}` : normKey(w));
        const seen = new Set([first.kind === 'literal' ? `\0${first.word}` : normKey(first.word)]);
        const rest = [];
        for (const it of order) {
            const k = keyOf(it.word);
            if (!seen.has(k)) {
                seen.add(k);
                rest.push(it);
            }
        }
        slots[0] = first;
        if (slots.length === 1)
            return [rest[0] ?? first];
        for (let i = 1; i < slots.length; i++)
            slots[i] = rest[i - 1] ?? null;
        return slots;
    }

    _nextWords(prevWord, slots) {
        const {key, sentenceStart} = contextOf(prevWord);
        const lex = this.lexicon;
        const items = [];
        const seen = new Set();
        const push = (k, score) => {
            if (seen.has(k) || k === key)
                return;
            const e = this._entry(k);
            if (!e)
                return;
            seen.add(k);
            const word = sentenceStart ? e.word.charAt(0).toUpperCase() + e.word.slice(1) : e.word;
            items.push({word, score, kind: 'next'});
        };
        const entry = this.bigrams?.get(sentenceStart ? '<s>' : key) ?? null;
        if (entry) {
            for (let j = 1; j < entry.length; j += 2)
                push(entry[j], Math.log(entry[j + 1] / entry[0]));
        }
        if (items.length < slots.length) {
            for (const i of lex.topWords(slots.length + 10)) {
                if (items.length >= slots.length)
                    break;
                push(lex.keys[i], lex.logp[i]);
            }
        }
        // iOS order: [2nd, BEST, 3rd, ...]
        const order = items.length >= 2 ? [items[1], items[0], ...items.slice(2)] : items;
        for (let i = 0; i < slots.length; i++)
            slots[i] = order[i] ?? null;
        return slots;
    }

    /**
     * P(next letter | prefix) over ALPHABET (a-z äöüß), smoothed with a letter
     * backoff so it never returns 0 and sums to 1.  Optional prevWord biases the
     * first letter of the next word by bigrams.
     */
    nextKeyProbs(prefix = '', prevWord = null) {
        const A = ALPHABET;
        const probs = new Map();
        const backoff = this.lexicon ? this.lexicon.letterProbs() : null;
        if (!this.lexicon) {
            for (let i = 0; i < A.length; i++)
                probs.set(A[i], 1 / A.length);
            return probs;
        }
        const q = normKey(prefix);
        const mass = new Float64Array(A.length);
        const idx = this._alphaIdx ??= new Map([...A].map((c, i) => [c.charCodeAt(0), i]));
        let M = 0;
        const usable = q === '' || /^[\p{L}'-]+$/u.test(q);
        if (usable) {
            this.lexicon.forEachChild(q, (c, m) => {
                const i = idx.get(c);
                if (i !== undefined) {
                    mass[i] += m;
                    M += m;
                }
            });
            for (const u of this.userDict.learned(this.lang)) {
                if (u.key.length > q.length && u.key.startsWith(q)) {
                    const i = idx.get(u.key.charCodeAt(q.length));
                    if (i !== undefined) {
                        const m = 500 * u.n;
                        mass[i] += m;
                        M += m;
                    }
                }
            }
            if (q === '' && prevWord !== null && this.bigrams) {
                const {key, sentenceStart} = contextOf(prevWord);
                const e = this.bigrams.get(sentenceStart ? '<s>' : key);
                if (e) {
                    // mix in the bigram successor distribution (scaled to half the mass)
                    let bt = 0;
                    for (let j = 1; j < e.length; j += 2)
                        bt += e[j + 1];
                    for (let j = 1; j < e.length; j += 2) {
                        const i = idx.get(e[j].charCodeAt(0));
                        if (i !== undefined)
                            mass[i] += M * (e[j + 1] / e[0]) * (e[0] / Math.max(bt, 1)) * 0.5;
                    }
                    M = mass.reduce((s, v) => s + v, 0);
                }
            }
        }
        const lambda = M / (M + 200);
        let s = 0;
        const out = new Float64Array(A.length);
        for (let i = 0; i < A.length; i++) {
            const pt = M > 0 ? mass[i] / M : 0;
            out[i] = lambda * pt + (1 - lambda) * backoff[i];
            out[i] = 0.995 * out[i] + 0.005 / A.length;
            s += out[i];
        }
        for (let i = 0; i < A.length; i++)
            probs.set(A[i], out[i] / s);
        return probs;
    }

    /**
     * The user kept `word` (typed it and moved on without correcting it, or
     * picked the literal suggestion).  Unknown words become learned after two
     * keeps.  Returns true if the word is (now) learned.  No-op in private mode.
     */
    learn(word) {
        if (!this.lexicon || typeof word !== 'string')
            return false;
        const w = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
        if (w.length < 2 || w.length > 40 || isProtectedToken(w) || this.userDict.isPrivate)
            return false;
        const key = normKey(w);
        if (this.lexicon.indexOf(key) >= 0)
            return false;
        return this.userDict.increment(this.lang, key, w) >= 2;
    }

    /** forget a learned word (and any correction block for it) */
    unlearn(word) {
        if (typeof word !== 'string')
            return false;
        return this.userDict.remove(this.lang, normKey(word.trim()));
    }

    /**
     * The user undid an autocorrection (BackSpace right after it).  Counts the
     * original as kept once, blocks that original from being autocorrected
     * again, and weakens the replacement if it was a learned user word.
     */
    undoAutocorrect(original, replacement = null) {
        if (this.userDict.isPrivate || typeof original !== 'string')
            return;
        const key = normKey(original);
        if (this.lexicon && this.lexicon.indexOf(key) < 0)
            this.userDict.increment(this.lang, key, original);
        this.userDict.block(this.lang, key);
        if (replacement) {
            const rk = normKey(replacement);
            if (this.lexicon && this.lexicon.indexOf(rk) < 0 && this.userDict.get(this.lang, rk))
                this.userDict.decrement(this.lang, rk);
        }
    }
}
