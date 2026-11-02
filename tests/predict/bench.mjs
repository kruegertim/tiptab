// Performance measurement (not a unit test):  node tests/predict/bench.mjs [de|en] [N]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PREDICT = path.resolve(here, '../../tablet-osk@kruegertim/predict');
const lang = process.argv[2] || 'de';
const N = Number(process.argv[3] || 3000);

const t0 = performance.now();
const {DataLoader} = await import(path.join(PREDICT, 'loader.js'));
const {PredictionEngine} = await import(path.join(PREDICT, 'engine.js'));
const t1 = performance.now();
const loader = new DataLoader({readFile: p => fs.readFileSync(p, 'utf8'), dataDir: path.join(PREDICT, 'data')});
const tl = performance.now();
const data = loader.load(lang);
const tLoad = performance.now() - tl;
const engine = new PredictionEngine({lexicon: data.lexicon, bigrams: data.bigrams, lang,
    layout: lang === 'en' ? 'qwerty' : 'qwertz'});
const tw = performance.now();
engine.warmUp();
const tWarm = performance.now() - tw;
console.log(`[${lang}] module import ${(t1 - t0).toFixed(1)} ms; load ${tLoad.toFixed(1)} ms ` +
    `(read ${data.stats.readMs.toFixed(1)}, JSON.parse ${data.stats.parseMs.toFixed(1)}, index ${data.stats.indexMs.toFixed(1)}); ` +
    `warmUp() ${tWarm.toFixed(1)} ms; heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);

// Alternative representation for comparison: explicit object trie built at load time
{
    const raw = JSON.parse(fs.readFileSync(path.join(PREDICT, 'data', `${lang}.json`), 'utf8'));
    const ts = performance.now();
    const root = {c: new Map(), f: 0, w: -1};
    raw.words.forEach((w, i) => {
        let node = root;
        const k = w.toLowerCase();
        for (const ch of k) {
            let nx = node.c.get(ch);
            if (!nx) {
                nx = {c: new Map(), f: 0, w: -1};
                node.c.set(ch, nx);
            }
            nx.f += raw.f[i];
            node = nx;
        }
        node.w = i;
    });
    console.log(`[${lang}] (comparison) explicit Map-trie build: ${(performance.now() - ts).toFixed(1)} ms ` +
        '(implicit sorted-array trie needs no build step)');
}

// random prefixes: words drawn by frequency rank (uniform over the top 20k), cut at random length,
// 30 % with a random typo
const lex = engine.lexicon;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const letters = 'abcdefghijklmnopqrstuvwxyz';
const words = [], prefixes = [];
const top = lex.topK(0, lex.size, 20000);
for (let i = 0; i < N; i++) {
    let w = lex.words[top[Math.floor(rnd() * top.length)]];
    if (rnd() < 0.3 && w.length > 2) {
        const p = Math.floor(rnd() * w.length);
        const r = rnd();
        const ch = letters[Math.floor(rnd() * 26)];
        if (r < 0.4)
            w = w.slice(0, p) + ch + w.slice(p + 1);
        else if (r < 0.7 && p < w.length - 1)
            w = w.slice(0, p) + w[p + 1] + w[p] + w.slice(p + 2);
        else
            w = w.slice(0, p) + ch + w.slice(p);
    }
    words.push(w);
    prefixes.push(w.slice(0, 1 + Math.floor(rnd() * w.length)));
}
const prevs = [null, 'ich', 'the', 'und', 'I', 'das', 'you'];

function measure(name, fn) {
    const t = [];
    for (let i = 0; i < N; i++) {
        const s = performance.now();
        fn(i);
        t.push(performance.now() - s);
    }
    t.sort((a, b) => a - b);
    const q = p => t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(3);
    console.log(`[${lang}] ${name.padEnd(14)} p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  p99 ${q(0.99)} ms  max ${t[t.length - 1].toFixed(2)} ms`);
}
measure('suggest', i => engine.suggest(prefixes[i], prevs[i % prevs.length]));
measure('suggest(next)', i => engine.suggest('', words[i]));
measure('autocorrect', i => engine.autocorrect(words[i], prevs[i % prevs.length]));
measure('nextKeyProbs', i => engine.nextKeyProbs(prefixes[i]));

// long / unknown words (worst cases for the fuzzy search)
const LONG = ['donaudampfschifffa', 'donaudampfschifffahrtsgesellschaft', 'Fahrradschlossschlüssel',
    'Kaffeetassenhalterx', 'qwertzuiopasdfghjkl', 'Bundesverfassungsgerichts', 'Geburtstagspartyy',
    'abcdefghijklmnopqrstuvwxyz', 'Rindfleischetikettierung', 'unbelievablyx', 'internationalizatoin',
    'xqzvbnmlkjhgf', 'Schifffahrtskapitän', 'Straßenbahnhaltestellen'];
const longPrefixes = [];
for (const w of LONG)
    for (let i = 1; i <= w.length; i++)
        longPrefixes.push(w.slice(0, i));
{
    const t = [];
    for (let r = 0; r < 5; r++) {
        for (const p of longPrefixes) {
            engine._memo = null;
            const s = performance.now();
            engine.suggest(p, 'die');
            engine.autocorrect(p, 'die');
            t.push(performance.now() - s);
        }
    }
    t.sort((a, b) => a - b);
    console.log(`[${lang}] long words: suggest+autocorrect per keystroke (${t.length} samples) ` +
        `p50 ${t[t.length >> 1].toFixed(3)} ms  p95 ${t[Math.floor(t.length * 0.95)].toFixed(3)} ms  max ${t[t.length - 1].toFixed(2)} ms`);
}
