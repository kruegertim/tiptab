// Pure helpers for predictController.js (no gi imports; node-testable).
//
// - word / context extraction from the text before the cursor
// - iOS-style suggestion slot building
// - autocorrect undo + "kept word" learning state machine

export const SEPARATORS = new Set([' ', '.', ',', '!', '?', ';', ':']);
export const PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':']);
const SENTENCE_END = /[.!?\n]/;
const WORD_CHAR = /[\p{L}\p{M}\p{N}'’-]/u;
const TRAILING_WORD = /[\p{L}\p{M}\p{N}'’-]*$/u;
const PREV_WORD = /([\p{L}\p{M}\p{N}'’-]+)[^\p{L}\p{M}\p{N}'’-]*$/u;

export const MAX_BUFFER = 96; // code points of context we keep

/** Number of Unicode code points (what deleteBackward(n) counts). */
export function cpLength(s) {
    let n = 0;
    for (const _ of s)
        n++;
    return n;
}

/** Drop the last code point. */
export function dropLast(s) {
    if (!s)
        return '';
    const cps = Array.from(s);
    cps.pop();
    return cps.join('');
}

/** Keep the last `max` code points. */
export function tail(s, max = MAX_BUFFER) {
    if (!s)
        return '';
    if (s.length <= max)
        return s;
    const cps = Array.from(s);
    return cps.length <= max ? s : cps.slice(cps.length - max).join('');
}

/** Text before the cursor; `cursor` is a character (code point) offset like the shell uses. */
export function textBeforeCursor(text, cursor) {
    if (typeof text !== 'string')
        return null;
    if (typeof cursor !== 'number' || cursor < 0)
        return text;
    const cps = Array.from(text);
    return cps.slice(0, Math.min(cursor, cps.length)).join('');
}

function trimWordEdges(w) {
    // leading hyphens/apostrophes are not part of the word ("-foo", "'tis" -> keep simple)
    return w.replace(/^['’-]+/u, '');
}

/**
 * Context from the text before the cursor.
 * @returns {{word:string, prevWord:string|null, atWordStart:boolean}}
 *   word: partial word directly before the cursor ('' after a separator)
 *   prevWord: the word before that (null across sentence ends / at start)
 */
export function extractContext(before) {
    before = before ?? '';
    const m = TRAILING_WORD.exec(before);
    let word = m ? m[0] : '';
    let rest = before.slice(0, before.length - word.length);
    const trimmed = trimWordEdges(word);
    if (trimmed.length !== word.length) {
        rest += word.slice(0, word.length - trimmed.length);
        word = trimmed;
    }
    let prevWord = null;
    const pm = PREV_WORD.exec(rest);
    if (pm) {
        const between = rest.slice(pm.index + pm[1].length);
        if (!SENTENCE_END.test(between)) {
            const pw = trimWordEdges(pm[1].replace(/['’-]+$/u, ''));
            prevWord = pw || null;
        }
    }
    return {word, prevWord, atWordStart: word === ''};
}

export function isWordChar(ch) {
    return WORD_CHAR.test(ch);
}

/** Words we never learn: digits, '@', too short / too long, no letters. */
export function isLearnable(word) {
    if (!word || word.length < 2 || word.length > 40)
        return false;
    if (/[\p{N}@_/\\]/u.test(word))
        return false;
    return /^[\p{L}\p{M}'’-]+$/u.test(word) && /\p{L}/u.test(word);
}

/** Apply the case pattern of `typed` to `word` (Capitalised / ALL CAPS). */
export function applyCase(word, typed) {
    if (!word || !typed)
        return word;
    const first = typed[0];
    const isUpper = c => c !== c.toLowerCase() && c === c.toUpperCase();
    if (typed.length > 1 && Array.from(typed).every(c => !/\p{L}/u.test(c) || isUpper(c)))
        return word.toUpperCase();
    if (isUpper(first))
        return word[0].toUpperCase() + word.slice(1);
    return word;
}

function buildOrderedSlots({word, suggestions, correction}) {
    const raw = (suggestions ?? []).slice(0, 3);
    while (raw.length < 3)
        raw.push(null);
    const slots = raw.map(s => (s && typeof s.word === 'string' && s.word
        ? {text: s.word, kind: s.kind || (word ? 'completion' : 'next')} : null));
    const repl = word && correction?.replacement && correction.replacement !== word
        ? correction.replacement : null;
    if (repl) {
        // what space will do must be what the bar shows: [ "typed" , correction , alternative ]
        const lower = new Set([word.toLowerCase(), repl.toLowerCase()]);
        const alt = slots.find(s => s && s.kind !== 'literal' && !lower.has(s.text.toLowerCase())) ?? null;
        return [{text: word, kind: 'literal'}, {text: repl, kind: 'correction'}, alt];
    }
    // no autocorrect on space (disabled / blocked / not confident): nothing is labelled a correction
    for (const s of slots) {
        if (s && s.kind === 'correction')
            s.kind = 'completion';
    }
    // drop duplicates (case-insensitive), keep positions
    const seen = new Set();
    return slots.map(s => {
        if (!s)
            return null;
        const k = s.text.toLowerCase();
        if (seen.has(k))
            return null;
        seen.add(k);
        return s;
    });
}

function rankOrder(list) {
    // [best, 2nd, 3rd] -> iOS order [2nd, best, 3rd]
    return [list[1] ?? null, list[0] ?? null, list[2] ?? null];
}

/**
 * Build the 3 suggestion slots.
 * @param {object} p
 * @param {string} p.word        current partial word ('' => next-word predictions)
 * @param {Array<{word:string, score?:number, kind?:string}>} p.suggestions  engine.suggest() result
 * @param {{replacement:string}|null} p.correction  engine.autocorrect(word) result (applied on space)
 * @param {boolean} [p.ordered]  suggestions are already positional iOS slots (predict/engine.js
 *        returns [alt|literal, BEST, alt] with nulls); otherwise they are ranked by score here
 * @returns {Array<{text:string, kind:string}|null>} exactly 3 entries
 */
export function buildSlots({word, suggestions, correction, ordered = false}) {
    if (ordered)
        return buildOrderedSlots({word, suggestions, correction});
    const seen = new Set();
    const items = [];
    const push = (text, kind) => {
        if (!text)
            return false;
        const key = text.toLowerCase();
        if (seen.has(key))
            return false;
        seen.add(key);
        items.push({text, kind});
        return true;
    };
    const sorted = (suggestions ?? [])
        .filter(s => s && typeof s.word === 'string' && s.word.length)
        .map((s, i) => ({s, i}))
        .sort((a, b) => {
            const sa = typeof a.s.score === 'number' ? a.s.score : -a.i;
            const sb = typeof b.s.score === 'number' ? b.s.score : -b.i;
            return sb - sa || a.i - b.i;
        })
        .map(({s}) => s);

    if (word && correction && correction.replacement && correction.replacement !== word) {
        // [ "typed" , correction , next alternative ]
        const literal = {text: word, kind: 'literal'};
        seen.add(word.toLowerCase());
        const corr = applyCase(correction.replacement, word);
        seen.add(corr.toLowerCase());
        let alt = null;
        for (const s of sorted) {
            const t = applyCase(s.word, word);
            if (!seen.has(t.toLowerCase())) {
                alt = {text: t, kind: s.kind === 'next' ? 'next' : (s.kind || 'completion')};
                break;
            }
        }
        return [literal, {text: corr, kind: 'correction'}, alt];
    }

    for (const s of sorted) {
        const kind = word ? (s.kind && s.kind !== 'literal' ? s.kind : 'completion') : 'next';
        push(word ? applyCase(s.word, word) : s.word, kind);
        if (items.length >= 3)
            break;
    }
    return rankOrder(items);
}

/**
 * Autocorrect undo + learning bookkeeping (pure state machine).
 *
 * Events (in the order the keyboard produces them):
 *   corrected(original, replacement, separator)  – charFilter replaced the word, separator not yet output
 *   typed(str)          – printable output by the user (via 'text-typed')
 *   backspace()         – 'key-sent' BackSpace (the key has already deleted one char)
 *   other()             – any other special key / context change
 *   wordEnded(word, {fromCorrection})  – a separator follows a user-typed word
 *
 * Returns actions for the controller:
 *   {type:'revert', deleteCount, text, original, replacement}  – on the first BackSpace after a correction
 *   {type:'learn', word}                                        – a word was kept
 */
export class UndoLearnState {
    constructor() {
        this.reset();
    }

    reset() {
        this.correction = null; // {original, replacement, separator, armed}
        this.pendingKeep = null; // word waiting to survive the next key
        this.blocked = new Set(); // lowercased originals whose correction the user reverted
    }

    /** Clear transient state (focus change / cursor jump) but keep the blocked set. */
    clearTransient() {
        const actions = this._commitKeep();
        this.correction = null;
        return actions;
    }

    isBlocked(word) {
        return this.blocked.has((word ?? '').toLowerCase());
    }

    corrected(original, replacement, separator) {
        const actions = this._commitKeep();
        this.correction = {original, replacement, separator, armed: false};
        return actions;
    }

    /** A user-typed word ended by a separator (no correction applied). */
    wordEnded(word) {
        const actions = this._commitKeep();
        if (isLearnable(word))
            this.pendingKeep = word;
        return actions;
    }

    /** Explicitly kept (literal slot tapped): learn at once. */
    keptExplicitly(word) {
        const actions = this._commitKeep();
        this.correction = null;
        if (isLearnable(word))
            actions.push({type: 'learn', word});
        return actions;
    }

    typed(str) {
        const c = this.correction;
        if (c && !c.armed && str === c.separator) {
            c.armed = true; // the separator that triggered the correction
            return [];
        }
        this.correction = null;
        // the kept word survives once something else is typed after the separator
        if (this.pendingKeep && str && !SEPARATORS.has(str))
            return this._commitKeep();
        return [];
    }

    backspace() {
        const c = this.correction;
        this.correction = null;
        if (c && c.armed) {
            this.pendingKeep = null;
            this.blocked.add(c.original.toLowerCase());
            // the controller also registers the original as kept once (engine.undoAutocorrect)
            return [{
                type: 'revert',
                // the BackSpace already removed the separator
                deleteCount: cpLength(c.replacement),
                text: c.original,
                original: c.original,
                replacement: c.replacement,
            }];
        }
        // deleting right after the separator: the word was not kept
        this.pendingKeep = null;
        return [];
    }

    other() {
        this.correction = null;
        return this._commitKeep();
    }

    _commitKeep() {
        const w = this.pendingKeep;
        this.pendingKeep = null;
        return w ? [{type: 'learn', word: w}] : [];
    }
}

/** Content purposes / hints that disable prediction (numeric values passed in by the caller). */
export function predictionAllowed({purpose, hints}, C) {
    const blockedPurposes = [C.PASSWORD, C.TERMINAL, C.DIGITS, C.NUMBER, C.PHONE, C.PIN]
        .filter(v => typeof v === 'number');
    if (blockedPurposes.includes(purpose))
        return false;
    const mask = (C.HIDDEN_TEXT ?? 0) | (C.SENSITIVE_DATA ?? 0);
    return !(hints & mask);
}

/** 'auto' -> layout based. */
export function resolveLanguage(pref, layout) {
    if (pref === 'de' || pref === 'en')
        return pref;
    return layout === 'qwerty' ? 'en' : 'de';
}
