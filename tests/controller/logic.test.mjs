// node --import ./register.mjs logic.test.mjs
import assert from 'node:assert/strict';
import {
    extractContext, buildSlots, UndoLearnState, isLearnable, applyCase, textBeforeCursor,
    cpLength, dropLast, tail, predictionAllowed, resolveLanguage,
} from '../../tablet-osk@kruegertim/predictLogic.js';

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('extractContext', () => {
    assert.deepEqual(extractContext(''), {word: '', prevWord: null, atWordStart: true});
    assert.deepEqual(extractContext('Hallo Wel'), {word: 'Wel', prevWord: 'Hallo', atWordStart: false});
    assert.deepEqual(extractContext('Hallo Welt '), {word: '', prevWord: 'Welt', atWordStart: true});
    assert.deepEqual(extractContext('Ende. Neu'), {word: 'Neu', prevWord: null, atWordStart: false});
    assert.deepEqual(extractContext('ja, gut'), {word: 'gut', prevWord: 'ja', atWordStart: false});
    assert.equal(extractContext('Straße größ').word, 'größ');
    assert.equal(extractContext("I don't").word, "don't");
    assert.equal(extractContext('E-Mail-Adr').word, 'E-Mail-Adr');
    assert.equal(extractContext('x -abc').word, 'abc');
    assert.equal(extractContext('foo\nbar').prevWord, null);
    assert.equal(extractContext('a1b2').word, 'a1b2');
});

t('helpers', () => {
    assert.equal(textBeforeCursor('Grüße dich', 5), 'Grüße');
    assert.equal(textBeforeCursor('a😀b', 2), 'a😀');
    assert.equal(textBeforeCursor(null, 1), null);
    assert.equal(cpLength('a😀ß'), 3);
    assert.equal(dropLast('a😀'), 'a');
    assert.equal(tail('abcdef', 3), 'def');
    assert.equal(applyCase('hallo', 'Hal'), 'Hallo');
    assert.equal(applyCase('hallo', 'HAL'), 'HALLO');
    assert.equal(applyCase('Haus', 'h'), 'Haus');
    assert.equal(applyCase('hallo', 'H'), 'Hallo');
    assert.ok(isLearnable('Kruegertim'));
    assert.ok(!isLearnable('abc1'));
    assert.ok(!isLearnable('a@b'));
    assert.ok(!isLearnable('x'));
    assert.equal(resolveLanguage('auto', 'qwerty'), 'en');
    assert.equal(resolveLanguage('auto', 'qwertz'), 'de');
    assert.equal(resolveLanguage('en', 'qwertz'), 'en');
    const C = {PASSWORD: 8, TERMINAL: 12, DIGITS: 2, NUMBER: 3, PHONE: 4, PIN: undefined, HIDDEN_TEXT: 64, SENSITIVE_DATA: 128};
    assert.ok(predictionAllowed({purpose: 0, hints: 0}, C));
    assert.ok(!predictionAllowed({purpose: 8, hints: 0}, C));
    assert.ok(!predictionAllowed({purpose: 12, hints: 0}, C));
    assert.ok(!predictionAllowed({purpose: 3, hints: 0}, C));
    assert.ok(!predictionAllowed({purpose: 0, hints: 128}, C));
    assert.ok(!predictionAllowed({purpose: 0, hints: 64 | 1}, C));
});

t('buildSlots', () => {
    const sug = [{word: 'haben', score: 3}, {word: 'habe', score: 5}, {word: 'hat', score: 1}];
    assert.deepEqual(buildSlots({word: 'hab', suggestions: sug, correction: null}).map(s => s?.text),
        ['haben', 'habe', 'hat']);
    // correction: literal | correction | next alternative (not duplicating)
    const s2 = buildSlots({word: 'Teh', suggestions: [{word: 'the', score: 9}, {word: 'then', score: 2}],
        correction: {replacement: 'The'}});
    assert.deepEqual(s2, [{text: 'Teh', kind: 'literal'}, {text: 'The', kind: 'correction'},
        {text: 'Then', kind: 'completion'}]);
    // next-word
    const s3 = buildSlots({word: '', suggestions: [{word: 'ist', score: 2}, {word: 'war', score: 1}], correction: null});
    assert.deepEqual(s3, [{text: 'war', kind: 'next'}, {text: 'ist', kind: 'next'}, null]);
    // dedupe + empty
    assert.deepEqual(buildSlots({word: 'a', suggestions: [], correction: null}), [null, null, null]);
    assert.deepEqual(buildSlots({word: 'ab', suggestions: [{word: 'Ab'}, {word: 'ab'}], correction: null})
        .map(s => s?.text ?? null), [null, 'Ab', null]);
    // correction equal to word -> no literal
    assert.equal(buildSlots({word: 'gut', suggestions: [], correction: {replacement: 'gut'}})[0], null);
});

t('buildSlots ordered (engine slots)', () => {
    const lit = {word: 'Hallp', kind: 'literal'};
    const eng = [lit, {word: 'Hallo', kind: 'correction', autocorrect: true}, {word: 'Halle', kind: 'completion'}];
    assert.deepEqual(buildSlots({word: 'Hallp', suggestions: eng, correction: {replacement: 'Hallo'}, ordered: true}),
        [{text: 'Hallp', kind: 'literal'}, {text: 'Hallo', kind: 'correction'}, {text: 'Halle', kind: 'completion'}]);
    // autocorrect off: correction kind is downgraded, positions kept
    assert.deepEqual(buildSlots({word: 'Hallp', suggestions: eng, correction: null, ordered: true}),
        [{text: 'Hallp', kind: 'literal'}, {text: 'Hallo', kind: 'completion'}, {text: 'Halle', kind: 'completion'}]);
    // engine slot disagrees with autocorrect(): bar follows autocorrect()
    assert.deepEqual(buildSlots({word: 'teh', suggestions: [null, {word: 'ten', kind: 'completion'}, null],
        correction: {replacement: 'the'}, ordered: true}),
    [{text: 'teh', kind: 'literal'}, {text: 'the', kind: 'correction'}, {text: 'ten', kind: 'completion'}]);
    assert.deepEqual(buildSlots({word: '', suggestions: [{word: 'bin', kind: 'next'}, null], correction: null, ordered: true}),
        [{text: 'bin', kind: 'next'}, null, null]);
    assert.deepEqual(buildSlots({word: 'a', suggestions: [{word: 'Ab'}, {word: 'ab'}, null], correction: null, ordered: true})
        .map(x => x?.text ?? null), ['Ab', null, null]);
});

t('undo after correction', () => {
    const st = new UndoLearnState();
    assert.deepEqual(st.corrected('teh', 'the', ' '), []);
    assert.deepEqual(st.typed(' '), []); // separator output arms
    const a = st.backspace();
    assert.equal(a[0].type, 'revert');
    assert.equal(a[0].deleteCount, 3);
    assert.equal(a[0].text, 'teh');
    assert.equal(a.length, 1);
    assert.ok(st.isBlocked('TEH'));
    // second backspace: nothing special
    assert.deepEqual(st.backspace(), []);
});

t('no undo when other key in between', () => {
    const st = new UndoLearnState();
    st.corrected('teh', 'the', ' ');
    st.typed(' ');
    st.typed('x');
    assert.deepEqual(st.backspace(), []);
    const st2 = new UndoLearnState();
    st2.corrected('teh', 'the', ' ');
    st2.typed(' ');
    st2.other();
    assert.deepEqual(st2.backspace(), []);
    // backspace before the separator was output (should not happen) -> no revert
    const st3 = new UndoLearnState();
    st3.corrected('teh', 'the', '.');
    assert.deepEqual(st3.backspace(), []);
});

t('kept-word learning', () => {
    const st = new UndoLearnState();
    assert.deepEqual(st.wordEnded('Tim'), []);
    assert.deepEqual(st.typed(' '), []);
    assert.deepEqual(st.typed('h'), [{type: 'learn', word: 'Tim'}]);
    // deleted right after: not kept
    st.wordEnded('Foo');
    st.typed(' ');
    st.backspace();
    assert.deepEqual(st.typed('x'), []);
    // digits never learned
    assert.deepEqual(st.wordEnded('abc1'), []);
    assert.deepEqual(st.typed('x'), []);
    // committed on reset / other key
    st.wordEnded('Wort');
    assert.deepEqual(st.clearTransient(), [{type: 'learn', word: 'Wort'}]);
    st.wordEnded('Wort');
    assert.deepEqual(st.other(), [{type: 'learn', word: 'Wort'}]);
    assert.deepEqual(st.keptExplicitly('Kruegertim'), [{type: 'learn', word: 'Kruegertim'}]);
});

console.log(`predictLogic: ${n} test groups passed`);
