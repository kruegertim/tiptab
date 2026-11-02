// node --import ./register.mjs controller.test.mjs [extensionDirWithPredict]
// Drives PredictController with a fake keyboard / settings / input method and a fake engine
// (fakeext/predict) or, if given, the real predict/ directory.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import GLib from './stubs/GLib.mjs';
import * as Main from './stubs/main.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = process.argv[2] ?? path.join(here, 'fakeext');
const REAL = !!process.argv[2];

class Emitter {
    constructor(signals) { this._h = []; this.constructor = {$gtype: {signals}}; }
    connectObject(...a) { a.pop(); for (let i = 0; i < a.length; i += 2) this._h.push([a[i], a[i + 1]]); }
    disconnectObject() { this._h = []; }
    emit(n, ...a) { for (const [s, f] of this._h) if (s === n) f(this, ...a); }
}
globalThis.global = {stage: Object.assign(new Emitter([]), {get_key_focus: () => null})};

class FakeSettings extends Emitter {
    constructor() {
        super([]);
        this.v = {suggestions: true, autocorrect: true, 'dynamic-hitareas': true,
            'prediction-language': 'auto', layout: 'qwertz', 'clear-userdict-request': 0};
    }
    get_boolean(k) { return this.v[k]; } get_string(k) { return this.v[k]; } get_int(k) { return this.v[k]; }
    set(k, val) { this.v[k] = val; this.emit(`changed::${k}`); }
}
class FakeKeyboard extends Emitter {
    constructor() {
        super(['text-typed', 'key-sent', 'suggestion-activated']);
        this.text = ''; this.mapped = false; this.slots = null; this.filter = null; this.resolver = null; this.enabled = null;
    }
    setSuggestions(s) { this.slots = s; }
    setSuggestionsEnabled(b) { this.enabled = b; }
    setCharFilter(f) { this.filter = f; }
    setKeyResolver(f) { this.resolver = f; }
    deleteBackward(n) { for (let i = 0; i < n; i++) { this.text = this.text.slice(0, -1); this.emit('key-sent', 'BackSpace'); } }
    typeText(s) { this.text += s; this.emit('text-typed', s); }
    // user actions
    type(str) { for (const ch of str) { this.filter?.(ch); this.text += ch; this.emit('text-typed', ch); GLib._advance(50); } }
    backspace() { this.text = this.text.slice(0, -1); this.emit('key-sent', 'BackSpace'); }
    show() { this.mapped = true; this.emit('notify::mapped'); }
    hide() { this.mapped = false; this.emit('notify::mapped'); }
    texts() { return this.slots?.map(s => s && (s.kind === 'literal' ? `"${s.text}"` : s.text)); }
}

const {PredictController} = await import('../../tablet-osk@kruegertim/predictController.js');
const settings = new FakeSettings();
const kb = new FakeKeyboard();
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
console.error = (...a) => origLog("ERR", ...a);
const pc = new PredictController({settings, keyboard: kb, extensionPath: extPath});

// before show: nothing loaded, no hooks
await GLib._run();
assert.equal(kb.filter, null);
assert.equal(kb.resolver, null);
kb.show();
await GLib._run(100);
assert.equal(kb.filter, null, 'load is delayed past the slide-in');
await GLib._run(1000);
assert.ok(logs.some(l => /\[tablet-osk\] prediction ready in \d+ ms/.test(l)), 'ready log');
assert.equal(typeof kb.filter, 'function');
assert.equal(typeof kb.resolver, 'function');
assert.equal(kb.enabled, true);
if (!REAL) assert.equal(globalThis.__preparsedUsed, true);

if (!REAL) {
    const eng = () => globalThis.__fakeEngine;
    // next-word at start
    await GLib._run();
    assert.deepEqual(kb.texts(), ['das', 'ich', null]);
    kb.type('hab');
    await GLib._run();
    assert.deepEqual(kb.texts(), ['habe', 'haben', null]);

    // tap middle suggestion -> replace partial word + space
    kb.emit('suggestion-activated', 1);
    assert.equal(kb.text, 'haben ');
    // smart punctuation removes the auto space
    kb.type('.');
    assert.equal(kb.text, 'haben.');
    kb.type(' ');

    // autocorrect + slots
    kb.type('teh');
    await GLib._run();
    assert.deepEqual(kb.texts(), ['"teh"', 'the', null]);
    kb.type(' ');
    assert.equal(kb.text, 'haben. the ');
    // immediate backspace reverts
    kb.backspace();
    assert.equal(kb.text, 'haben. teh');
    assert.deepEqual(eng().learnCalls, ['teh']);
    assert.deepEqual(eng().undoCalls, [['teh', 'the']]);
    // space now keeps 'teh' (blocked correction)
    kb.type(' ');
    assert.equal(kb.text, 'haben. teh ');
    kb.type('x');
    assert.deepEqual(eng().learnCalls, ['teh', 'teh']);

    // autocorrect on punctuation, not reverted after another key
    kb.type(' dsa,');
    assert.equal(kb.text, 'haben. teh x das,');
    kb.type(' ');
    kb.backspace();
    assert.equal(kb.text, 'haben. teh x das,');

    // literal slot tap keeps the typed word and learns it
    kb.type(' Teh');
    // Teh is blocked now -> no correction slot; use a fresh word
    kb.backspace(); kb.backspace(); kb.backspace();
    kb.type('dsa');
    await GLib._run();
    assert.deepEqual(kb.texts()[0], '"dsa"');
    kb.emit('suggestion-activated', 0);
    assert.ok(kb.text.endsWith(' dsa '));
    assert.equal(eng().learnCalls.at(-1), 'dsa');
    kb.type('ok');

    // key resolver delegates to touch.js with nextKeyProbs
    const r = kb.resolver({x: 10, y: 10}, [{char: 'a', cx: 0, cy: 0, w: 40, h: 50}]);
    assert.equal(r, 's');
    assert.equal(globalThis.__touchCall.opts.enabled, true);
    assert.ok(globalThis.__touchCall.probs instanceof Map);

    // surrounding text: adopted when settled, ignored right after own edits
    Main.inputMethod.currentFocus = {};
    Main.inputMethod._text = 'Hallo zusammen';
    Main.inputMethod._cursor = 5;
    GLib._advance(1000);
    Main.inputMethod.emit('surrounding-text-set');
    await GLib._run();
    assert.deepEqual(kb.texts(), [null, 'hallo', null]);
    // stale surrounding right after our own output is ignored, re-read once settled
    kb.type('x');
    Main.inputMethod.emit('surrounding-text-set'); // still says 'Hallo|'
    await GLib._run(0);
    assert.equal(pc._buffer, 'Hallox');
    Main.inputMethod._text = 'Hallox zusammen';
    Main.inputMethod._cursor = 6;
    await GLib._run(1000);
    assert.equal(pc._buffer, 'Hallox');
    // cursor moved by the user (tap in the field): context follows
    Main.inputMethod._cursor = 15;
    Main.inputMethod.emit('surrounding-text-set');
    await GLib._run();
    assert.equal(pc._buffer, 'Hallox zusammen');

    // password field: disabled, no learning, hooks removed
    const before = eng().learnCalls.length;
    Main.inputMethod.content_purpose = 8;
    Main.inputMethod.emit('notify::content-purpose');
    assert.equal(kb.enabled, false);
    assert.equal(kb.filter, null);
    assert.equal(kb.resolver, null);
    assert.deepEqual(kb.slots, [null, null, null]);
    Main.inputMethod.content_purpose = 0;
    Main.inputMethod.content_hints = 128; // SENSITIVE_DATA
    Main.inputMethod.emit('notify::content-hints');
    assert.equal(kb.enabled, false);
    Main.inputMethod.content_hints = 0;
    Main.inputMethod.emit('notify::content-hints');
    assert.equal(kb.enabled, true);
    assert.equal(eng().learnCalls.length, before);
    Main.inputMethod.currentFocus = null;

    // settings toggles
    settings.set('suggestions', false);
    assert.equal(kb.enabled, false);
    settings.set('suggestions', true);
    settings.set('dynamic-hitareas', false);
    assert.equal(kb.resolver, null);
    settings.set('dynamic-hitareas', true);
    settings.set('autocorrect', false);
    kb.type(' teh ');
    assert.ok(kb.text.endsWith(' teh '));
    settings.set('autocorrect', true);

    // clear userdict request
    settings.set('clear-userdict-request', 1);
    assert.equal(globalThis.__fakeStore.cleared, 1);

    // language change reloads
    settings.set('layout', 'qwerty');
    await GLib._run();
    assert.equal(eng().lang, 'en');
    assert.equal(typeof kb.filter, 'function');

    // hide resets context
    kb.hide();
    await GLib._run();
}

if (REAL) {
    // end-to-end with the real engine + data
    await GLib._run();
    console.log('start slots:', kb.texts());
    kb.type('Ich bin');
    await GLib._run();
    console.log('"Ich bin" slots:', kb.texts());
    kb.type(' ');
    await GLib._run();
    console.log('"Ich bin " slots:', kb.texts());
    kb.type('morgen in Berlni');
    await GLib._run();
    console.log('"…Berlni" slots:', kb.texts());
    kb.type(' ');
    console.log('after space:', JSON.stringify(kb.text));
    const corrected = kb.text;
    kb.backspace();
    console.log('after BackSpace:', JSON.stringify(kb.text));
    if (corrected !== 'Ich bin morgen in Berlni ') {
        assert.equal(kb.text, 'Ich bin morgen in Berlni');
        kb.type(' ');
        assert.equal(kb.text, 'Ich bin morgen in Berlni ', 'reverted word not corrected again');
    }
    // per-key timing of the whole refresh (suggest + autocorrect + slots) and the resolver
    const words = 'das ist ein ziemlich langer satz mit verschiedenen wörtern und tippfehlern wie hallp zusammem'.split(' ');
    const times = [];
    const rtimes = [];
    const cands = 'qwertzuiopasdfghjklyxcvbnm'.split('').map((c, i) => ({char: c, cx: (i % 10) * 50 + 25, cy: Math.floor(i / 10) * 60 + 30, w: 46, h: 56}));
    for (const w of words) {
        for (const ch of w + ' ') {
            kb.type(ch);
            const t0 = performance.now();
            pc._refresh();
            times.push(performance.now() - t0);
            const t1 = performance.now();
            kb.resolver({x: 120, y: 40}, cands);
            rtimes.push(performance.now() - t1);
        }
    }
    const pct = (a, q) => a.slice().sort((x, y) => x - y)[Math.floor(q * (a.length - 1))].toFixed(2);
    console.log(`refresh per key: p50 ${pct(times, 0.5)} ms, p95 ${pct(times, 0.95)} ms, max ${pct(times, 1)} ms`);
    console.log(`resolver per touch: p50 ${pct(rtimes, 0.5)} ms, p95 ${pct(rtimes, 0.95)} ms`);
    // learning: unknown word kept twice becomes learned
    kb.type(' Kruegertim ok Kruegertim ok ');
    await GLib._run(0);
    const ud = pc._userDict;
    console.log('learned Kruegertim:', ud.isLearned('de', 'kruegertim'));
    assert.ok(ud.isLearned('de', 'kruegertim'));
    kb.type('Kruegerti');
    await GLib._run();
    console.log('"Kruegerti" slots:', kb.texts());
    // password field: nothing learned
    Main.inputMethod.currentFocus = {};
    Main.inputMethod.content_purpose = 8;
    Main.inputMethod.emit('notify::content-purpose');
    kb.type(' Geheimwort x Geheimwort x Geheimwort x ');
    assert.ok(!ud.get('de', 'geheimwort'));
    assert.equal(kb.filter, null);
    Main.inputMethod.content_purpose = 0;
    Main.inputMethod.currentFocus = null;
    Main.inputMethod.emit('notify::content-purpose');
    // clear
    settings.set('clear-userdict-request', 5);
    assert.ok(!ud.isLearned('de', 'kruegertim'));
    kb.hide();
    await GLib._run(5000);
}

pc.destroy();
assert.equal(kb.filter, null);
assert.equal(kb.resolver, null);
assert.equal(GLib._pending(), 0, 'no leaked GLib sources');
console.log = origLog;
console.log(`predictController (${REAL ? 'real engine' : 'fake engine'}): all assertions passed`);
