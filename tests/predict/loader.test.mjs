import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {loader, loaderModule, DATA_DIR} from './helpers.mjs';

const {Lexicon, BloomFilter, parseLanguageData, DataLoader} = loaderModule;

test('data files exist, are < 3 MB and well-formed', () => {
    for (const lang of ['de', 'en']) {
        const p = path.join(DATA_DIR, `${lang}.json`);
        const size = fs.statSync(p).size;
        assert.ok(size < 3 * 1024 * 1024, `${lang}: ${size} bytes`);
        const {lexicon, bigrams} = loader.load(lang);
        assert.ok(lexicon.size >= 40000 && lexicon.size <= 60000, `${lang}: ${lexicon.size} words`);
        for (let i = 1; i < lexicon.size; i++)
            assert.ok(lexicon.keys[i - 1] < lexicon.keys[i], `sorted/unique at ${i}`);
        assert.ok(bigrams.get('<s>'));
    }
});

test('loader caches and lexicon lookups work', () => {
    assert.equal(loader.load('de'), loader.load('de'));
    const {lexicon} = loader.load('de');
    assert.equal(lexicon.words[lexicon.indexOf('haus')], 'Haus');
    assert.equal(lexicon.indexOf('hallp'), -1);
    const [lo, hi] = lexicon.range('hall');
    assert.ok(lexicon.keys.slice(lo, hi).every(k => k.startsWith('hall')));
    assert.equal(lexicon.words[lexicon.topK(lo, hi, 1)[0]], 'hallo');
    assert.equal(lexicon.topK(0, lexicon.size, 3).map(i => lexicon.keys[i]).join(' '), 'ich sie das');
});

test('bloom filter: contains every lexicon key, low false-positive rate', () => {
    for (const lang of ['de', 'en']) {
        const {lexicon} = loader.load(lang);
        for (const k of lexicon.keys)
            assert.ok(lexicon.bloom.has(k));
        let fp = 0;
        for (let i = 0; i < 20000; i++)
            fp += lexicon.bloom.has(`qz${i}xv`) ? 1 : 0;
        assert.ok(fp / 20000 < 0.01, `fp rate ${fp / 20000}`);
    }
    { const lx = loader.load('de').lexicon; assert.equal(lx.indexOf('hausmeisterinnen'), -1); assert.ok(lx.isValid('hausmeisterinnen')); }  // only in the full dictionary
});

test('parseLanguageData accepts objects, rejects unknown versions; async loading', async () => {
    const d = parseLanguageData({v: 1, lang: 'xx', words: ['b', 'a'].sort(), f: [100, 50]});
    assert.equal(d.lexicon.size, 2);
    assert.throws(() => parseLanguageData({v: 99}));
    const al = new DataLoader({readFile: p => fs.promises.readFile(p), dataDir: DATA_DIR});
    const r = await al.loadAsync('en');
    assert.ok(r.lexicon.indexOf('the') >= 0);
    assert.throws(() => new DataLoader({readFile: p => fs.promises.readFile(p), dataDir: DATA_DIR}).load('en'));
    assert.throws(() => loader.path('../etc'));
});

test('small synthetic lexicon', () => {
    const words = ['Apfel', 'auto', 'autor', 'baum'];
    const lex = new Lexicon({words, f: [80, 120, 60, 90]});
    assert.deepEqual(lex.range('aut'), [1, 3]);
    const seen = [];
    lex.forEachChild('aut', (c, m) => seen.push(String.fromCharCode(c)));
    assert.deepEqual(seen, ['o']);
    assert.ok(BloomFilter);
});

test('format v2: successor indices, case-ambiguity list; v1 still works', () => {
    // sorted keys: apfel auto essen haus ich
    const v2 = parseLanguageData({v: 2, lang: 'xx', words: ['Apfel', 'auto', 'Essen', 'Haus', 'ich'],
        f: [80, 90, 70, 100, 120], amb: [2], bigrams: {ich: [10, 3, 6, 0, 2], '<s>': [5, 4, 5]}});
    assert.deepEqual(v2.bigrams.get('ich'), [10, 'haus', 6, 'apfel', 2]);
    assert.deepEqual(v2.bigrams.get('ich'), [10, 'haus', 6, 'apfel', 2], 'resolved once, stable');
    assert.deepEqual(v2.bigrams.lookup('ich', 'apfel'), {count: 2, total: 10});
    assert.equal(v2.bigrams.get('<s>')[1], 'ich');
    const L = v2.lexicon;
    assert.equal(L.isCapitalOnly(L.indexOf('haus')), true);
    assert.equal(L.isCapitalOnly(L.indexOf('apfel')), true);
    assert.equal(L.isCapitalOnly(L.indexOf('essen')), false, 'in amb');
    assert.equal(L.isCapitalOnly(L.indexOf('auto')), false, 'lower case canonical');
    const v1 = parseLanguageData({v: 1, lang: 'xx', words: ['Haus', 'ich'], f: [100, 120],
        bigrams: {ich: [10, 'haus', 6]}});
    assert.deepEqual(v1.bigrams.get('ich'), [10, 'haus', 6]);
    assert.equal(v1.lexicon.isCapitalOnly(0), false, 'v1 data never forces case');
});

test('shipped data: German nouns are capital-only, ambiguous words are not', () => {
    const L = loader.load('de').lexicon;
    for (const w of ['haus', 'auto', 'tag', 'mädchen'])
        assert.ok(L.isCapitalOnly(L.indexOf(w)), w);
    for (const w of ['ich', 'essen', 'sie', 'morgen', 'leben'])
        assert.ok(!L.isCapitalOnly(L.indexOf(w)), w);
    const B = loader.load('de').bigrams;
    assert.ok(Object.keys(B.table).length >= 10000, 'bigram contexts');
    assert.equal(B.get('guten')[1], 'tag');
});
