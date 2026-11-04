// node --test tests/predict/
import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEngine, MemoryUserDict, engineModule} from './helpers.mjs';

const de = makeEngine('de');
const en = makeEngine('en');

const ac = (eng, w, prev = null) => eng.autocorrect(w, prev)?.replacement ?? null;

// ------------------------------------------------------------ autocorrect: required cases
const POSITIVE = [
    // [engine, typed, expected, prevWord]
    [de, 'Hallp', 'Hallo'],
    [de, 'dsa', 'das'],
    [de, 'nicth', 'nicht'],
    [en, 'teh', 'the'],
    [de, 'udn', 'und'],
    // more German
    [de, 'ihc', 'ich'],
    [de, 'mrogen', 'morgen'],
    [de, 'dnake', 'danke'],
    [de, 'Gebrutstag', 'Geburtstag'],
    [de, 'sclafen', 'schlafen'],
    [de, 'fur', 'für'],           // forgotten umlaut
    [de, 'tschuss', 'tschüss'],
    [de, 'Mittwcoh', 'Mittwoch'],
    [de, 'knnst', 'kannst'],
    [de, 'bitet', 'bitte'],
    // more English
    [en, 'adn', 'and'],
    [en, 'hte', 'the'],
    [en, 'wiht', 'with'],
    [en, 'yuo', 'you'],
    [en, 'becuase', 'because'],
    [en, 'recieve', 'receive'],
    [en, 'somthing', 'something'],
    [en, 'peopel', 'people'],
    [en, 'ahve', 'have'],
    [en, 'hosue', 'house'],
    [en, 'dont', "don't"],
    [en, 'i', 'I'],
];

for (const [eng, typed, expected, prev] of POSITIVE) {
    test(`autocorrect ${eng.lang}: ${typed} -> ${expected}`, () => {
        const r = eng.autocorrect(typed, prev ?? null);
        assert.ok(r, `expected a correction for ${typed}`);
        assert.equal(r.replacement, expected);
        assert.ok(r.confidence > 0 && r.confidence <= 1);
        assert.equal(r.original, typed);
    });
}

const NEGATIVE = [
    // valid words
    [de, 'Hallo'], [de, 'das'], [de, 'Haus'], [de, 'haus'], [de, 'nicht'], [de, 'weil'],
    [de, 'Lampe'], [de, 'kannst'], [en, 'the'], [en, 'house'], [en, 'their'],
    // rare but valid dictionary words (bloom filter) and compounds
    [de, 'Geburtstagsparty'], [de, 'Hausmeisterei'], [de, 'Fahrradschlossschlüssel'],
    [de, 'Kaffeetassenhalter'],
    // numbers, URLs, mail addresses, mixed alphanumerics, paths
    [de, '12345'], [de, '3.14'], [de, 'www.example.com'], [de, 'example.org'],
    [de, 'https://gnome.org'], [en, 'tim@example.com'], [en, 'abc123'], [en, 'B2B'],
    [de, 'Win10'], [de, '/usr/share'], [en, 'snake_case'], [en, '#hashtag'],
    // mixed case (camelCase / brand)
    [en, 'iPhone'], [de, 'GitHub'], [en, 'McDonald'],
    // very short, ambiguous
    [de, 'ud'], [de, 'ab'], [en, 'ot'], [en, 'im'], [de, 'x'],
    // nonsense without a close candidate
    [de, 'xyzq'], [en, 'qqqq'],
];

for (const [eng, typed] of NEGATIVE) {
    test(`autocorrect ${eng.lang}: leaves "${typed}" alone`, () => {
        assert.equal(eng.autocorrect(typed), null);
    });
}

test('autocorrect keeps the case pattern', () => {
    assert.equal(ac(de, 'hallp'), 'hallo');
    assert.equal(ac(de, 'Hallp'), 'Hallo');
    assert.equal(ac(de, 'HALLP'), 'HALLO');
    assert.equal(ac(en, 'Teh'), 'The');
    assert.equal(ac(en, 'TEH'), 'THE');
    assert.equal(ac(de, 'Dsa'), 'Das');
    // German nouns keep their capital even when typed lower case
    assert.equal(ac(de, 'gebrutstag'), 'Geburtstag');
});

test('learned words are never autocorrected; blocked corrections are not repeated', () => {
    const eng = makeEngine('de');
    assert.equal(ac(eng, 'Hallp'), 'Hallo');
    eng.undoAutocorrect('Hallp', 'Hallo');
    assert.equal(eng.autocorrect('Hallp'), null, 'blocked after undo');
    assert.equal(eng.userDict.get('de', 'hallp').n, 1);
    assert.equal(eng.learn('Hallp'), true, 'second keep => learned');
    assert.equal(eng.autocorrect('Hallp'), null);
    eng.unlearn('Hallp');
    assert.equal(ac(eng, 'Hallp'), 'Hallo', 'unlearn removes word and block');
});

// ------------------------------------------------------------ suggest
test('suggest: autocorrect case puts the literal in slot 0 and the correction in the middle', () => {
    const s = de.suggest('Hallp');
    assert.equal(s.length, 3);
    assert.deepEqual([s[0].word, s[0].kind], ['Hallp', 'literal']);
    assert.equal(s[1].word, 'Hallo');
    assert.equal(s[1].kind, 'correction');
    assert.equal(s[1].autocorrect, true);
    assert.ok(s[2] && s[2].word !== 'Hallo');
});

test('suggest: completions for a prefix, middle is the best guess', () => {
    const s = de.suggest('Hal');
    assert.equal(s[0].kind, 'literal');
    assert.equal(s[1].word, 'Hallo');
    const s2 = en.suggest('beca');
    assert.equal(s2[1].word, 'because');
});

test('suggest: valid typed word stays in slot 0 (not quoted), no autocorrect flag', () => {
    const s = de.suggest('das');
    assert.equal(s[0].word, 'das');
    assert.equal(s[0].kind, 'completion');
    assert.equal(s[0].exact, true);
    assert.ok(!s.some(x => x?.autocorrect));
    assert.equal(new Set(s.filter(Boolean).map(x => x.word.toLowerCase())).size, s.filter(Boolean).length);
});

test('suggest: German noun shown capitalised, sentence-start capitalisation follows typed text', () => {
    assert.equal(de.suggest('haus')[0].word, 'Haus');
    assert.equal(de.suggest('Ver')[1].word[0], 'V');
    assert.ok(de.suggest('VER').filter(Boolean).every(x => x.word === x.word.toUpperCase()));
});

test('suggest: bigram context changes the ranking', () => {
    const plain = de.suggest('T', null).filter(Boolean).map(x => x.word);
    const ctx = de.suggest('T', 'guten').filter(Boolean).map(x => x.word);
    assert.ok(ctx.includes('Tag'), `got ${ctx}`);
    assert.notDeepEqual(plain, ctx);
});

test('suggest: next word after space (bigrams), iOS order [2nd, BEST, 3rd]', () => {
    const s = de.suggest('', 'ich');
    assert.equal(s.length, 3);
    assert.ok(s.every(x => x && x.kind === 'next'));
    assert.equal(s[1].word, 'habe');
    const st = de.suggest('', null);
    assert.ok(st.every(x => /^\p{Lu}/u.test(x.word)), 'sentence start capitalised');
    const after = en.suggest('', 'Hello.');
    assert.ok(after.every(x => /^\p{Lu}/u.test(x.word)));
    const unk = de.suggest('', 'Xylophonspieler');   // unknown context -> frequent words
    assert.equal(unk.filter(Boolean).length, 3);
});

test('suggest: max parameter and protected tokens', () => {
    assert.equal(de.suggest('Ha', null, 5).length, 5);
    assert.deepEqual(de.suggest('www.go'), [null, null, null]);
    assert.deepEqual(de.suggest('42'), [null, null, null]);
});

test('suggest: learned word appears as completion', () => {
    const eng = makeEngine('de');
    eng.learn('Krügerei');
    assert.ok(!eng.suggest('Krüge').filter(Boolean).some(x => x.word === 'Krügerei'));
    eng.learn('Krügerei');
    assert.ok(eng.suggest('Krüge').filter(Boolean).some(x => x.word === 'Krügerei'));
});

// ------------------------------------------------------------ nextKeyProbs
function checkDist(m) {
    let s = 0;
    for (const [, p] of m) {
        assert.ok(p > 0);
        s += p;
    }
    assert.ok(Math.abs(s - 1) < 1e-9, `sum ${s}`);
    assert.equal(m.size, 30);
}

test('nextKeyProbs: smoothed distribution over a-z äöüß', () => {
    for (const p of ['', 'h', 'Hall', 'nich', 'qqqqx', "don'", 'schö'])
        checkDist(de.nextKeyProbs(p));
    const m = de.nextKeyProbs('Hall');
    const best = [...m].sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(best, 'o');
    assert.ok(m.get('o') > 20 * m.get('p'));
    const n = de.nextKeyProbs('nich');
    assert.ok(n.get('t') > 0.9);
    const e = en.nextKeyProbs('th');
    assert.ok(e.get('e') > e.get('x'));
    checkDist(en.nextKeyProbs('', 'I'));
});

// ------------------------------------------------------------ learning / private mode
test('learn: word kept twice is learned; known words are not stored; private mode stores nothing', () => {
    const ud = new MemoryUserDict();
    const eng = makeEngine('de', 'qwertz', ud);
    assert.equal(eng.learn('Haus'), false);
    assert.equal(ud.get('de', 'haus'), null);
    assert.equal(eng.learn('Zorkbar'), false);
    assert.equal(eng.learn('Zorkbar,'), true);
    assert.ok(ud.isLearned('de', 'zorkbar'));
    assert.equal(eng.learn('4711'), false);
    ud.setPrivate(true);
    assert.equal(eng.learn('Geheimwort1x'), false);
    assert.equal(eng.learn('Passwortchen'), false);
    eng.learn('Passwortchen');
    assert.equal(ud.get('de', 'passwortchen'), null);
    eng.undoAutocorrect('Hallp', 'Hallo');
    assert.equal(ud.isBlocked('de', 'hallp'), false);
    ud.setPrivate(false);
    ud.clear();
    assert.equal(ud.get('de', 'zorkbar'), null);
});

// ------------------------------------------------------------ layout / helpers
test('layout adjacency: QWERTZ vs QWERTY', () => {
    const qz = engineModule.buildAdjacency('qwertz');
    const qy = engineModule.buildAdjacency('qwerty');
    const c = s => s.charCodeAt(0);
    assert.ok(qz.get(c('z')).has(c('t')) && qz.get(c('z')).has(c('u')));
    assert.ok(!qy.get(c('z')).has(c('t')));
    assert.ok(qy.get(c('y')).has(c('t')));
    assert.ok(qz.get(c('o')).has(c('p')) && qz.get(c('p')).has(c('ü')));
    const eng = makeEngine('de');
    eng.setLayout('qwertz');
    const a = eng.errorCost('zeit', 'teit');   // z next to t on QWERTZ
    eng.setLayout('qwerty');
    const b = eng.errorCost('zeit', 'teit');
    assert.ok(a < b);
});

test('case helpers', () => {
    const {casePattern, applyCase, isProtectedToken} = engineModule;
    assert.equal(casePattern('haus'), 'lower');
    assert.equal(casePattern('Haus'), 'capital');
    assert.equal(casePattern('HAUS'), 'upper');
    assert.equal(casePattern('iPhone'), 'mixed');
    assert.equal(applyCase('HALLP', 'hallo'), 'HALLO');
    assert.equal(applyCase('Teh', 'the'), 'The');
    assert.equal(applyCase('gebrutstag', 'Geburtstag'), 'Geburtstag');
    assert.ok(isProtectedToken('a1') && isProtectedToken('a@b') && !isProtectedToken("don't"));
});

test('setLanguage switches lexicon via loader', () => {
    const eng = makeEngine('de');
    eng.setLanguage('en');
    assert.equal(eng.lang, 'en');
    assert.equal(ac(eng, 'teh'), 'the');
    eng.setLanguage('de');
    assert.equal(ac(eng, 'udn'), 'und');
});
