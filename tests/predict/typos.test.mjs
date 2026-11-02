// Quality tests on realistic typing errors (node --test tests/predict/).
// Prints the hit rates so changes to the engine or the data can be compared.
import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEngine, engineModule} from './helpers.mjs';
import {DE_TYPOS, EN_TYPOS, DE_KEEP, EN_KEEP, DE_UNKNOWN_KEEP, EN_UNKNOWN_KEEP} from './typos.mjs';

const engines = {de: makeEngine('de'), en: makeEngine('en')};
engines.de.warmUp();
engines.en.warmUp();
const now = () => performance.now();

function rate(lang, list) {
    const e = engines[lang];
    let top1 = 0, inBar = 0;
    const misses = [];
    for (const [typed, want, prev = null] of list) {
        const got = e.autocorrect(typed, prev)?.replacement ?? typed;
        if (got === want)
            top1++;
        else
            misses.push(`${typed}->${got} (${want})`);
        if (got === want || e.suggest(typed, prev).some(s => s?.word === want))
            inBar++;
    }
    return {top1: top1 / list.length, inBar: inBar / list.length, misses};
}

for (const [lang, list, minTop1] of [['de', DE_TYPOS, 0.9], ['en', EN_TYPOS, 0.9]]) {
    test(`realistic typos ${lang}: autocorrect >= ${minTop1 * 100} %, suggestion bar >= 95 %`, t => {
        const r = rate(lang, list);
        t.diagnostic(`${lang}: autocorrect ${(r.top1 * 100).toFixed(1)} %, in bar ${(r.inBar * 100).toFixed(1)} % ` +
            `of ${list.length}; misses: ${r.misses.join(', ')}`);
        assert.ok(r.top1 >= minTop1, `autocorrect hit rate ${r.top1}`);
        assert.ok(r.inBar >= 0.95, `suggestion hit rate ${r.inBar}`);
    });
}

for (const [lang, list, prev] of [['de', DE_KEEP, 'und'], ['en', EN_KEEP, 'and']]) {
    test(`valid ${lang} words are never changed (mid-sentence)`, () => {
        const e = engines[lang];
        const changed = list.filter(w => e.autocorrect(w, prev)).map(w => `${w}->${e.autocorrect(w, prev).replacement}`);
        assert.deepEqual(changed, []);
    });
}

for (const [lang, list, prev] of [['de', DE_UNKNOWN_KEEP, 'und'], ['en', EN_UNKNOWN_KEEP, 'and']]) {
    test(`unknown but intended ${lang} words (names, slang) are mostly kept`, t => {
        const e = engines[lang];
        const changed = list.filter(w => e.autocorrect(w, prev)).map(w => `${w}->${e.autocorrect(w, prev).replacement}`);
        t.diagnostic(`changed: ${changed.join(', ') || 'none'}`);
        assert.ok(changed.length <= Math.ceil(list.length * 0.1), changed.join(', '));
    });
}

test('synthetic neighbour-key / swap / missing-letter typos of frequent words', t => {
    for (const lang of ['de', 'en']) {
        const e = engines[lang];
        const L = e.lexicon;
        const adj = engineModule.buildAdjacency(lang === 'de' ? 'qwertz' : 'qwerty');
        let seed = 4711;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const words = L.topWords(1500).map(i => L.words[i])
            .filter(w => w.length >= 5 && w.length <= 10 && /^[a-zäöüß]+$/i.test(w));
        const res = {sub: [0, 0], swap: [0, 0], del: [0, 0]};
        for (const w of words) {
            const k = w.toLowerCase();
            const p = 1 + Math.floor(rnd() * (k.length - 2));
            const near = [...adj.get(k.charCodeAt(p)) ?? []].map(([c]) => c).filter(c => c >= 97);
            const typos = {
                sub: near.length ? k.slice(0, p) + String.fromCharCode(near[Math.floor(rnd() * near.length)]) + k.slice(p + 1) : null,
                swap: k[p] !== k[p + 1] ? k.slice(0, p) + k[p + 1] + k[p] + k.slice(p + 2) : null,
                del: k.slice(0, p) + k.slice(p + 1),
            };
            for (const [kind, typo] of Object.entries(typos)) {
                if (!typo || e.isKnownWord(typo))
                    continue;   // the typo is itself a word: nothing to correct
                const typed = w[0] !== k[0] ? typo[0].toUpperCase() + typo.slice(1) : typo;
                res[kind][0]++;
                if (e.autocorrect(typed, 'und')?.replacement === w)
                    res[kind][1]++;
            }
        }
        const pct = ([n, ok]) => ok / n;
        t.diagnostic(`${lang}: ` + Object.entries(res).map(([k, v]) => `${k} ${(pct(v) * 100).toFixed(1)} % of ${v[0]}`).join(', '));
        assert.ok(pct(res.sub) >= 0.85, `${lang} sub`);
        assert.ok(pct(res.swap) >= 0.8, `${lang} swap`);
        assert.ok(pct(res.del) >= 0.45, `${lang} del`);
    }
});

test('per-keystroke cost while typing the typo list stays < 5 ms (p95)', t => {
    for (const [lang, list] of [['de', DE_TYPOS], ['en', EN_TYPOS]]) {
        const e = engines[lang];
        const times = [];
        for (let r = 0; r < 2; r++) {
            for (const [typed, , prev = null] of list) {
                for (let i = 1; i <= typed.length; i++) {
                    const p = typed.slice(0, i);
                    const t0 = now();
                    e.suggest(p, prev);
                    e.nextKeyProbs(p);
                    if (i === typed.length)
                        e.autocorrect(p, prev);
                    times.push(now() - t0);
                }
            }
        }
        times.sort((a, b) => a - b);
        const p95 = times[Math.floor(times.length * 0.95)];
        t.diagnostic(`${lang}: p50 ${times[times.length >> 1].toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, ` +
            `max ${times[times.length - 1].toFixed(2)} ms over ${times.length} keystrokes`);
        assert.ok(p95 < 5, `${lang} p95 ${p95}`);
    }
});
