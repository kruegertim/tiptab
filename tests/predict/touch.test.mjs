import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEngine, touchModule} from './helpers.mjs';

const {resolveTouch, resolveTouchDetailed} = touchModule;

// QWERTZ letter rows, 60x80 px keys, rows staggered like the real layout.
const W = 60, H = 80;
function qwertzKeys() {
    const rows = [['qwertzuiopü', 1.5], ['asdfghjklöä', 1.75], ['yxcvbnm', 2.0]];
    const keys = [];
    rows.forEach(([s, x0], r) => {
        [...s].forEach((ch, i) => keys.push({char: ch, cx: (x0 + i + 0.5) * W, cy: (r + 0.5) * H, w: W, h: H}));
    });
    return keys;
}
const keys = qwertzKeys();
const key = c => keys.find(k => k.char === c);
const de = makeEngine('de');

test('touch slightly inside "p" near "o" after "Hall" resolves to "o"', () => {
    const o = key('o'), p = key('p');
    const x = (o.cx + p.cx) / 2 + 0.12 * W;      // 12 % of a key into p
    const pt = {x, y: p.cy};
    assert.equal(resolveTouch(pt, keys, null, {}), 'p', 'without probs = visible key');
    assert.equal(resolveTouch(pt, keys, de.nextKeyProbs('Hall'), {}), 'o');
    const d = resolveTouchDetailed(pt, keys, de.nextKeyProbs('Hall'), {});
    assert.equal(d.changed, true);
    assert.equal(d.visibleKey.char, 'p');
});

test('clear centre hits always return the visible key', () => {
    const probs = de.nextKeyProbs('Hall');   // 'o' dominates
    for (const k of keys) {
        for (const [fx, fy] of [[0, 0], [0.29, 0], [-0.29, 0.29], [0, -0.29]])
            assert.equal(resolveTouch({x: k.cx + fx * W, y: k.cy + fy * H}, keys, probs, {}), k.char);
    }
});

test('never picks a key farther than ~0.5 key from the touch', () => {
    // probability mass entirely on 'a', touch on the outer edge of 'l' -> must not become 'a'
    const probs = new Map([...'abcdefghijklmnopqrstuvwxyzäöüß'].map(c => [c, c === 'a' ? 0.999 : 0.001 / 29]));
    const l = key('l');
    assert.equal(resolveTouch({x: l.cx - 0.45 * W, y: l.cy}, keys, probs, {}), 'l');
    // ... but the adjacent key is allowed if it is likely enough
    const p2 = new Map([...'abcdefghijklmnopqrstuvwxyzäöüß'].map(c => [c, c === 'k' ? 0.97 : 0.001]));
    assert.equal(resolveTouch({x: l.cx - 0.45 * W, y: l.cy}, keys, p2, {}), 'k');
    // 'j' is more than half a key away from the touch: excluded even with p = 0.97
    const p3 = new Map([...'abcdefghijklmnopqrstuvwxyzäöüß'].map(c => [c, c === 'j' ? 0.97 : 0.001]));
    assert.notEqual(resolveTouch({x: l.cx - 0.45 * W, y: l.cy}, keys, p3, {}), 'j');
});

test('disabled option or missing probs returns the visible key', () => {
    const p = key('p');
    const pt = {x: p.cx - 0.45 * W, y: p.cy};
    assert.equal(resolveTouch(pt, keys, de.nextKeyProbs('Hall'), {enabled: false}), 'p');
    assert.equal(resolveTouch(pt, keys, null, {enabled: true}), 'p');
});

test('vertical ambiguity uses the prefix too', () => {
    // after "nich" a touch on the upper edge of 'g' (below 't'/'z') should become 't'
    const g = key('g'), t = key('t');
    const pt = {x: (g.cx + t.cx) / 2, y: g.cy - 0.42 * H};
    assert.equal(resolveTouch(pt, keys, de.nextKeyProbs('nich'), {}), 't');
});

test('touch outside all keys picks the nearest key; empty key list -> null', () => {
    assert.equal(resolveTouch({x: -100, y: H / 2}, keys, null, {}), 'q');
    assert.equal(resolveTouch({x: 0, y: 0}, [], null, {}), null);
});

test('non-letter visible key is never overridden', () => {
    const extra = [...keys, {char: '-', cx: key('m').cx + 3 * W, cy: key('m').cy, w: W, h: H}];
    const minus = extra[extra.length - 1];
    assert.equal(resolveTouch({x: minus.cx - 0.45 * W, y: minus.cy}, extra, de.nextKeyProbs('Hall'), {}), '-');
});
