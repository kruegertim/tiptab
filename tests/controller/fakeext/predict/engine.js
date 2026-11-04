// Tiny fake engine implementing the Amendment-2 API.
export class PredictionEngine {
    constructor({lexicon, bigrams, userDict, lang, layout}) {
        this.lang = lang; this.layout = layout;
        this.lex = lexicon; this.big = bigrams; this.ud = userDict; this.learnCalls = [];
        globalThis.__fakeEngine = this;
    }
    setLanguage(l) { this.lang = l; }
    suggest(prefix, prev, max = 3) {
        const l = this._suggestRanked(prefix, prev, max);
        return [l[1] ?? null, l[0] ?? null, l[2] ?? null]; // positional iOS slots like predict/engine.js
    }
    _suggestRanked(prefix, prev, max) {
        if (!prefix)
            return (this.big[prev?.toLowerCase() ?? '<s>'] ?? []).map((w, i) => ({word: w, score: 10 - i, kind: 'next'})).slice(0, max);
        const p = prefix.toLowerCase();
        return this.lex.filter(w => w.startsWith(p)).slice(0, max).map((w, i) => ({word: w, score: 10 - i, kind: 'completion'}));
    }
    autocorrect(word) {
        const map = {teh: 'the', dsa: 'das'};
        const r = map[word.toLowerCase()];
        if (!r || this.ud.words.has(word.toLowerCase()))
            return null;
        return {replacement: word[0] === word[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r, confidence: 0.9};
    }
    nextKeyProbs(prefix) { return new Map([['a', 0.5], ['s', 0.5]]); }
    learn(w) { this.learnCalls.push(w); this.ud.learn(w); }
    undoAutocorrect(o, r) { this.undoCalls = [...(this.undoCalls ?? []), [o, r]]; this.learnCalls.push(o); }
    unlearn(w) { this.ud.words.delete(w.toLowerCase()); }
}
